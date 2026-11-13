import * as THREE from 'three';
import { XRButton } from './threejsAddons/XRButton.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { mountButtonsToDOM } from './menuSystem.js';
import { paintElementToCanvas } from './htmlInCanvas.js';
import { createVrWindowManager, isHtmlTextField, VR_WINDOW_DISTANCE } from './vrWindows.js';
import { mountCodeHighlight } from './syntaxHighlight.js';
import {
	GS_VERSION,
	loadVersionManifest,
	mergeVersionList,
	isCurrentVersionEntry
} from './version.js';
import * as GSContext from './creationContext.js';
import * as GSMerge from './communityMerge.js';
import { normalizeEnvironmentHdri, environmentHdriLoadUrl, environmentHdriSignature, hdriFormatFromName, HDRI_FILE_MAX_BYTES } from './sceneHdri.js';
import * as ChatPrompt from './chatPrompt.js';
import { gsAlert, gsConfirm, gsPrompt, configureDialogs, dialogCard, refreshDialogMode, installDialogGlobals } from './gsDialog.js';
import { initEmbedUi, mountEmbedChrome, parseEmbedRoute } from './embedExport.js';
import { EXPORTS_OFF_MESSAGE, OWNER_KEY_HEADER } from './sceneExportPolicy.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { initSceneExport } from './exporter.js';
import { createTwinSticks } from './twinSticks.js';
import { createCameraControls, CAMERA_MODES, STICK_MODES, normalizeCameraMode, ORBIT_TARGET, DEFAULT_CAMERA_POSITION, isTextEntry } from './cameraControls.js';
import { sanitizeDescription, DESCRIPTION_MAX_CHARS, DESCRIPTION_PLACEHOLDER } from './sceneDescription.js';
import { THUMB_WIDTH, THUMB_HEIGHT, THUMB_MAX_BYTES } from './sceneThumbnail.js';
import { createOriginRotation, normalizeOriginRotation, isIdentityOriginRotation } from './originGizmo.js';
import { createSceneFit, DOME_MARGIN, FAR_MARGIN, isDomeObject } from './sceneFit.js';
import { createPhotoCapture, askCameraBeforeXr, registerQuestPassthroughItem } from './photoCapture.js';
import { createSbsRenderer, mountRenderTab } from './sbsRender.js';
import * as gsTechnicalMode from './technicalMode.js';
import * as gsCamPipeline from './passthroughTexture.js';
// p5.js sketch import (paste / file / zip / URL -> panel in the scene). Self-contained;
// it only uses the window.gs* hooks set up next to gsCreateP5Surface below.
import './p5Import.js';

// ============================================================================
// Configuration
// ============================================================================
const THUMBSTICK_DEADZONE = 0.15;
const STICK_SCROLL_PX_PER_S = 900; // VR window scroll at full thumbstick deflection (locomotion off)
const MOVE_SPEED = 1.5;  // metres/second at full left-thumbstick deflection
const TURN_SPEED = 1.8;  // radians/second at full right-thumbstick deflection
const VR_KEYBOARD_GAP = 0.03; // metres between the menu window and the keyboard window

// ============================================================================
// Scene Setup
// ============================================================================
const appElement = document.getElementById('app');

const scene = new THREE.Scene();
scene.background = null; // transparent for passthrough

// Render distance, shared by desktop, phone and VR. VR and the windowed view use
// this same camera: three.js copies camera.near/far into the XR session's
// depthNear/depthFar every frame, so VR draws RENDER_NEAR..RENDER_FAR metres from
// the headset. See syncRenderDistance() for how desktop matches it.
const RENDER_NEAR = 0.1;
const RENDER_FAR = 100;
const RENDER_EYE_HEIGHT = 1.6; // where the VR view starts in the player rig (local-floor)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, RENDER_NEAR, RENDER_FAR);
camera.position.set(0, 1.6, 0);

// ============================================================================
// In-world menu render priority (Three.js layer 1)
// ============================================================================
// The VR windows, head-locked HUD, and aim reticles must draw above every mesh
// the user or injected code adds. Those meshes stay on layer 0 (the default).
// The menu is taken off layer 0 and placed on layer 1.
//
// Layer 1 is not a depth override: WebXR renders the scene layer and the eye
// layer in one pass, so a closer mesh would still win the depth test. Menu
// materials therefore also get depthTest/depthWrite off, transparent:true (so
// they sort in the late transparent pass), and a high renderOrder.
//
// Three r180 reserves layer 1 for the LEFT eye and layer 2 for the RIGHT eye
// (WebXRManager masks the right eye to layers 0 and 2; StereoCamera does the
// same for cardboard). The menu is also enabled on layer 2 so it does not
// vanish in the right eye. Scene objects are never put on layer 1 or 2.
const MENU_LAYER = 1;
const MENU_RIGHT_EYE_LAYER = 2;
const MENU_RENDER_ORDER = 10000;
const MENU_RETICLE_RENDER_ORDER = 10001;
const menuPriorityRoots = [];

function registerMenuRoot(object, renderOrder = MENU_RENDER_ORDER) {
	if (!object || menuPriorityRoots.indexOf(object) !== -1) return;
	object.userData.menuRenderOrder = renderOrder;
	menuPriorityRoots.push(object);
}

function applyMenuLayerPriority() {
	// Desktop camera only tests layer 0 unless layer 1 is enabled. Enabling it
	// does not disable layer 0, so windowed mode still draws the scene. XR eye
	// cameras force layers 1 and 2 themselves; cardboard stereo cameras are
	// re-enabled here in case something clears their masks.
	camera.layers.enable(MENU_LAYER);
	stereoCam.cameraL.layers.enable(MENU_LAYER);
	stereoCam.cameraR.layers.enable(MENU_RIGHT_EYE_LAYER);

	// Raycasters default to layer 0. Menu meshes are not on layer 0, so the
	// UI rays must test layer 1 or panel hits/reticles stop registering.
	raycaster.layers.enable(MENU_LAYER);
	_hitRaycaster.layers.enable(MENU_LAYER);

	for (let i = 0; i < menuPriorityRoots.length; i++) {
		const root = menuPriorityRoots[i];
		if (!root) continue;
		const rootOrder = root.userData.menuRenderOrder || MENU_RENDER_ORDER;
		root.traverse((obj) => {
			// set() drops every other layer, including 0. Layer 2 keeps the
			// right eye. Children parented under a menu root later (injected
			// code, hud.add, panel.add, ...) are picked up by this traverse.
			obj.layers.set(MENU_LAYER);
			obj.layers.enable(MENU_RIGHT_EYE_LAYER);
			const order = obj.userData.menuRenderOrder || rootOrder;
			if (obj.renderOrder < order) obj.renderOrder = order;
			const mats = obj.material;
			if (!mats) return;
			const list = Array.isArray(mats) ? mats : [mats];
			for (let m = 0; m < list.length; m++) {
				const mat = list[m];
				if (!mat) continue;
				// transparent:true puts the menu in the transparent pass so it
				// paints after opaque AND after ordinary transparent scene meshes.
				mat.transparent = true;
				mat.depthTest = false;
				mat.depthWrite = false;
			}
		});
	}
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
// Drawing-buffer size is kept in sync by applyRendererSize(); pass false so
// the CSS (position:fixed; inset:0; 100%/100dvh) keeps the canvas covering
// the visible page instead of being locked to stale inline pixel sizes.
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.xr.enabled = true;
appElement.appendChild(renderer.domElement);
renderer.setClearColor(0x000000, 0.0);
renderer.domElement.style.touchAction = 'none';

// Touch drags (one finger and two) were panning/overscrolling the browser
// page instead of orbiting the scene. touch-action:none on #app/canvas
// (index.html) opts the browser out; preventDefault on touchmove covers
// Safari, which still moves the visual viewport. Skip editable fields and
// any element that can actually scroll (chat lists, code editor) so typing
// and in-panel scrolling keep working. Buttons still receive taps — this
// does not call preventDefault on touchstart/click. Desktop mouse is untouched.
function touchTargetAllowsBrowserScroll(target) {
	if (!(target instanceof Element)) return false;
	if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
	let el = target;
	while (el && el !== document.body && el !== document.documentElement) {
		const style = window.getComputedStyle(el);
		const oy = style.overflowY;
		const ox = style.overflowX;
		const scrollsY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
		const scrollsX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
		if (scrollsY || scrollsX) return true;
		el = el.parentElement;
	}
	return false;
}
function preventPagePanFromTouch(e) {
	if (touchTargetAllowsBrowserScroll(e.target)) return;
	if (e.cancelable) e.preventDefault();
}
document.addEventListener('touchmove', preventPagePanFromTouch, { passive: false, capture: true });
// iOS two-finger drag/pinch moves the page frame via gesture events, which
// touchmove preventDefault does not cover.
document.addEventListener('gesturestart', preventPagePanFromTouch, { passive: false });
document.addEventListener('gesturechange', preventPagePanFromTouch, { passive: false });

// Desktop (non-XR) camera controls are the stock three.js addons (Orbit,
// Map, Trackball, Fly, First person); see cameraControls.js and the Controls
// tab section below. They are disabled while WebXR or Cardboard drives the camera.

// Walk-in-AR only: finger-driven transform gizmos for arPlacementRoot (not WebXR).
// Three controls so "All" can show translate + rotate + scale handles together.
let arGizmoVisible = false;
let arGizmoDragging = false;
let arGizmoMode = 'all'; // 'all' | 'translate' | 'rotate' | 'scale'
const arGizmoHelpers = [];
const arTransformByMode = {};
for (const mode of ['translate', 'rotate', 'scale']) {
	const ctrl = new TransformControls(camera, renderer.domElement);
	ctrl.enabled = false;
	ctrl.setMode(mode);
	ctrl.setSize(mode === 'scale' ? 1.2 : 1.35);
	ctrl.space = 'world';
	ctrl.showX = true;
	ctrl.showY = true;
	ctrl.showZ = true;
	ctrl.addEventListener('dragging-changed', (e) => {
		arGizmoDragging = !!e.value;
		// While one handle is grabbed, silence the sibling gizmos so they don't fight.
		for (const other of Object.values(arTransformByMode)) {
			if (other === ctrl) continue;
			if (e.value) {
				other.enabled = false;
			} else if (arGizmoVisible) {
				other.enabled = (arGizmoMode === 'all' || other.getMode() === arGizmoMode);
			}
		}
	});
	const helper = ctrl.getHelper();
	helper.name = `arTransformHelper-${mode}`;
	helper.visible = false;
	scene.add(helper);
	arGizmoHelpers.push(helper);
	arTransformByMode[mode] = ctrl;
}
// Back-compat aliases used by gather/system-object skips
const arTransformControls = arTransformByMode.translate;
const arTransformHelper = arGizmoHelpers[0];

// ============================================================================
// DOM Elements
// ============================================================================
const overlayRoot = document.getElementById('overlay-root');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const statusElement = document.getElementById('status');
const desktopChat = document.getElementById('desktop-chat');
const desktopChatHeader = document.getElementById('desktop-chat-header');
const desktopChatMessages = document.getElementById('desktop-chat-messages');
const desktopChatInput = document.getElementById('desktop-chat-input');
const desktopSendButton = document.getElementById('desktop-send-button');
const desktopMicButton = document.getElementById('desktop-mic-button');
const desktopAttachButton = document.getElementById('desktop-attach-button');
const desktopAttachInput = document.getElementById('desktop-attach-input');
const desktopAttachmentsRow = document.getElementById('desktop-attachments');
const desktopFilesPickerButton = document.getElementById('desktop-files-picker-button');
const themeFilesPickerButton = document.getElementById('theme-files-picker-button');
const dchatThemeAttachmentsRow = document.getElementById('dchat-theme-attachments');
const dchatFilesList = document.getElementById('dchat-files-list');
const dchatFilesInput = document.getElementById('dchat-files-input');
const dchatFilesUpload = document.getElementById('dchat-files-upload');
const dchatFilesClear = document.getElementById('dchat-files-clear');
const filesPickerModal = document.getElementById('files-picker-modal');
const filesPickerList = document.getElementById('files-picker-list');
const filesPickerCancel = document.getElementById('files-picker-cancel');
const filesPickerConfirm = document.getElementById('files-picker-confirm');
const desktopModelSelect = document.getElementById('desktop-model-select');
const desktopOllamaModelRow = document.getElementById('desktop-ollama-model-row');
const desktopOllamaModelSelect = document.getElementById('desktop-ollama-model-select');
const desktopChatMinimizeBtn = document.getElementById('desktop-chat-minimize');
const desktopChatExpandBtn = document.getElementById('desktop-chat-expand');
const desktopChatReopenBtn = null; // Show Chat removed — restore via the Show UI button after minimize
const chatOverlayBar = document.getElementById('chat-overlay');
const dchatEnvModeMount = document.getElementById('dchat-env-mode');
const dchatEnvControls = document.getElementById('dchat-env-controls');
const dchatColorPicker = document.getElementById('dchat-color-picker');
const dchatColorPreview = document.getElementById('dchat-color-preview');
const dchatResetCameraBtn = document.getElementById('dchat-reset-camera');
const dchatNavType = document.getElementById('dchat-nav-type');
const dchatScenesButtonsMount = document.getElementById('dchat-scenes-buttons');
const dchatCurrentScene = document.getElementById('dchat-current-scene');
const dchatCommunityButtonsMount = document.getElementById('dchat-community-buttons');
const dchatCommunityList = document.getElementById('dchat-community-list');
const dchatThemesButtonsMount = document.getElementById('dchat-themes-buttons');
const dchatThemesList = document.getElementById('dchat-themes-list');
const dchatThemeChatMessages = document.getElementById('dchat-theme-chat-messages');
const dchatThemeChatInput = document.getElementById('dchat-theme-chat-input');
const dchatThemeChatSend = document.getElementById('dchat-theme-chat-send');
const dchatThemeRemember = document.getElementById('dchat-theme-remember');
const dchatThemeRememberCommunity = document.getElementById('dchat-theme-remember-community');
const dchatCodeEditor = document.getElementById('dchat-code-editor');
const dchatCodeLive = document.getElementById('dchat-code-live');
const dchatCodeApply = document.getElementById('dchat-code-apply');
const dchatCodeRevert = document.getElementById('dchat-code-revert');
const dchatCodeStatus = document.getElementById('dchat-code-status');
const dchatCodeHint = document.getElementById('dchat-code-hint');
const dchatCodeHighlight = document.getElementById('dchat-code-highlight');
const dchatHdriFile = document.getElementById('dchat-hdri-file');
const dchatHdriPick = document.getElementById('dchat-hdri-pick');
const dchatHdriClear = document.getElementById('dchat-hdri-clear');
const dchatHdriUrl = document.getElementById('dchat-hdri-url');
const dchatHdriUrlLoad = document.getElementById('dchat-hdri-url-load');
const dchatHdriBg = document.getElementById('dchat-hdri-bg');
const dchatHdriStatus = document.getElementById('dchat-hdri-status');


// ============================================================================
// Shared menu button specs (menuSystem.js), mounted as live <svg> buttons in
// the menu. In VR the same menu is painted into the headset (vrWindows.js),
// so there is one definition and one rendering path. All clicks (mouse,
// touch, controller ray) funnel into handleMenuAction() below.
// ============================================================================
// AR / VR: which immersive session Enter starts (see "AR / VR mode" below).
// Inside an AR session they switch live between passthrough and the colour
// skybox; inside a VR session AR restarts the session as immersive-ar
// (chooseXrMode). The top-bar AR | VR toggle does the same.
const ENV_MODE_BUTTONS = [
	{ id: 'ar', label: 'AR (passthrough)', action: 'env:ar' },
	{ id: 'vr', label: 'VR (color)', action: 'env:vr' }
];
const EXIT_XR_BUTTON = [
	{ id: 'exitXr', label: 'Exit VR', action: 'env:exit', variant: 'warning' }
];
const SCENES_BUTTONS = [
	{ id: 'importFile', label: 'Import .vrscene.json', action: 'scenes:importFile' },
	{ id: 'clearScene', label: 'Clear All From Scene', action: 'scenes:clear', variant: 'secondary' }
];
// Share & Export lives on its own menu tab (data-tab="share"). "Export" (save
// to the server slot) and "Load Saved" stay as handleMenuAction cases for tests
// and programmatic use; they are not buttons on this tab.
const COMMUNITY_BUTTONS = [
	{ id: 'upload', label: 'Upload Current Scene', action: 'community:upload', variant: 'accent' },
	{ id: 'refresh', label: 'Refresh', action: 'community:refresh' }
];
const THEME_BUTTONS = [
	{ id: 'uploadTheme', label: 'Upload Current Theme', action: 'themes:upload', variant: 'accent' },
	{ id: 'refreshThemes', label: 'Refresh', action: 'themes:refresh' },
	{ id: 'resetTheme', label: 'Reset Default', action: 'themes:reset' }
];

// Routes both a desktop SVG click and an XR controller-ray/touch hit to the
// same behavior, so the behavior itself is written exactly once.
function handleMenuAction(action) {
	switch (action) {
		case 'env:vr':
			chooseXrMode('vr');
			break;
		case 'env:ar':
			chooseXrMode('ar');
			break;
		case 'env:exit':
			exitXrToDesktop();
			break;
		case 'env:windowAnchor':
			setWindowAnchorMode(windowAnchorMode === 'follow' ? 'fixed' : 'follow');
			break;
		case 'env:nav:free':
			locomotionMode = 'free';
			if (dchatNavType) dchatNavType.value = 'free';
			updateStatus('Locomotion: WASD/free-fly', 'connected');
			renderDomEnv();
			break;
		case 'env:nav:planar':
			locomotionMode = 'planar';
			if (dchatNavType) dchatNavType.value = 'planar';
			updateStatus('Locomotion: First Person', 'connected');
			renderDomEnv();
			break;
		case 'scenes:export':
			if (!sceneExportsAllowed()) { showExportsBlocked(); break; }
			showExportModal();
			break;
		case 'scenes:exportModel:glb':
		case 'scenes:exportModel:gltf':
		case 'scenes:exportModel:fbx':
		case 'scenes:exportModel:obj':
		case 'scenes:exportModel:blender':
			sceneModelExport.open(action.split(':')[2]);
			break;
		case 'scenes:shareLink':
			shareCurrentScene();
			break;
		case 'scenes:embed':
			embedCurrentScene();
			break;
		case 'scenes:openShareTab':
			document.querySelector('.dchat-tab[data-tab="share"]')?.click();
			break;
		case 'scenes:downloadVrscene':
			// Programmatic only: the Share & Export tab no longer has a
			// Download .vrscene.json button.
			downloadVrsceneJson();
			break;
		case 'scenes:importFile':
			fileInput.click();
			break;
		case 'scenes:loadSaved':
			loadSceneFromServer();
			break;
		case 'scenes:clear':
			clearSceneContent();
			break;
		case 'files:upload':
			dchatFilesInput?.click();
			break;
		case 'files:clear':
			clearContextLibrary();
			break;
		case 'code:toggleLive':
			if (dchatCodeLive) {
				dchatCodeLive.checked = !dchatCodeLive.checked;
				if (dchatCodeLive.checked && codeEditorDirty) scheduleLiveCodeApply();
			}
			renderDomSceneList();
			break;
		case 'code:apply':
			// Apply hot reloads (changed blocks only, state kept).
			hotReloadFromEditor({ fromLive: false });
			break;
		case 'code:reset':
			// Old behavior: clear the scene and re-run every block from scratch.
			applyCodeFromEditor({ fromLive: false });
			break;
		case 'code:revert':
			revertCodeEditor();
			renderDomSceneList();
			break;
		case 'community:upload':
			uploadCurrentSceneToCommunity();
			break;
		case 'community:refresh':
			refreshCommunityScenes();
			break;
		case 'themes:upload':
			uploadCurrentThemeToCommunity();
			break;
		case 'themes:refresh':
			refreshCommunityThemes();
			break;
		case 'themes:reset':
			applyTheme(DEFAULT_THEME, { announce: true });
			break;
		case 'theme:toggleRemember':
			setRememberTheme(!rememberTheme);
			break;
		case 'communitySection:scenes':
			setCommunitySection('scenes');
			renderDomSceneList();
			break;
		case 'communitySection:themes':
			setCommunitySection('themes');
			renderDomSceneList();
			break;
		case 'chatSection:scene':
			setChatSection('scene');
			break;
		case 'chatSection:theme':
			setChatSection('theme');
			break;
		case 'chatSection:prompt':
			setChatSection('prompt');
			break;
	}
}

/** End the active WebXR session (or mobile pseudo-XR) and return to the desktop DOM UI. */
function exitXrToDesktop() {
	if (mobileXRMode) {
		exitMobileXRMode();
		updateStatus('Exited to desktop', 'connected');
		return;
	}
	const session = renderer?.xr?.getSession?.();
	if (session) {
		session.end().catch((err) => {
			console.warn('XR session end failed:', err);
			updateStatus(`Could not exit XR: ${err?.message || err}`, 'error');
		});
		return;
	}
	updateStatus('Not in an XR session', '');
}

// ============================================================================
// State
// ============================================================================
let messages = [];       // Full messages for API context (includes raw code blocks)
let displayMessages = []; // Cleaned messages for canvas display
const WELCOME_MSG = 'VR Code Assistant ready. Ask me to add objects, modify the scene, or inject HTML — I\'ll write and execute the code live.';
let isLoading = false;
let selectedBackend = null; // backend key from /api/backends (e.g. 'claude', 'openai-sol', 'ollama') - set once it resolves
let backendLabels = {}; // id -> display label from /api/backends
let backendProviders = {}; // id -> 'claude' | 'openai' | 'ollama' from /api/backends

/** Provider for a backend key; falls back to the key prefix for older servers. */
function backendProvider(id) {
	if (backendProviders[id]) return backendProviders[id];
	if (id === 'ollama') return 'ollama';
	return /^openai/.test(id || '') ? 'openai' : 'claude';
}

/** Human-readable name for the currently selected model/provider. */
function getActiveModelDisplayName() {
	if (selectedBackend === 'ollama') {
		const name = selectedOllamaModel || desktopOllamaModelSelect?.value;
		if (name && !/^Checking|^No local|^Could not/.test(name)) return name;
		return 'Ollama';
	}
	const fromMap = backendLabels[selectedBackend];
	if (fromMap) return fromMap;
	const opt = desktopModelSelect?.selectedOptions?.[0];
	if (opt?.textContent) {
		return opt.textContent.split('—')[0].trim() || 'Assistant';
	}
	const fallbacks = {
		claude: 'Claude',
		fable: 'Claude Fable',
		openai: 'GPT6 Astra',
		'openai-sol': 'GPT6.1 Sol',
		'openai-6-sol': 'GPT6 Sol',
		'openai-luna': 'GPT6 Luna',
		'claude-opus-55': 'Claude Opus 5.5',
		'claude-sonnet-55': 'Claude Sonnet 5.5',
		'claude-haiku-55': 'Claude Haiku 5.5',
		ollama: 'Ollama'
	};
	return fallbacks[selectedBackend] || 'Assistant';
}

function thinkingStatusText() {
	return `${getActiveModelDisplayName()} is thinking...`;
}
let selectedOllamaModel = null; // e.g. 'llama3.2:latest' - set once the Ollama model list loads
let cachedPrompts = null; // { systemPrompt, fixCodePrompt, themePrompt } - fetched once from /api/prompts
let pendingAttachments = []; // files staged via the 📎 / Files picker, sent with the next scene message - see buildUserContent()
let pendingThemeAttachments = []; // Files-library picks staged for theme chat
let contextLibrary = []; // persisted Files-tab library (IndexedDB)
let filesPickerTarget = 'scene'; // 'scene' | 'theme'
let filesPickerSelected = new Set();

// Ollama always runs on the SAME machine as the browser (this is what makes
// it "local"), regardless of whether this page itself was loaded from
// Vercel or from `python run.py`. So instead of proxying through this app's
// own server (which, when deployed, has no network path to the visitor's
// laptop at all), the browser talks to the user's Ollama directly.
//
// This only actually works when THIS PAGE is also served from localhost
// (i.e. via `python run.py`, not the hosted Vercel site). Reaching a
// loopback address (127.0.0.1/localhost) from a page loaded off a public
// origin is blocked by the browser's Private Network Access policy - unlike
// ordinary CORS, this can't be opted into via Ollama's OLLAMA_ORIGINS
// setting (Ollama doesn't send the special Access-Control-Allow-Private-
// Network response header the preflight requires), so the request just
// hangs/never resolves rather than failing fast. Confirmed empirically:
// identical fetch from https://localhost:PORT succeeds instantly, the same
// fetch from the hosted Vercel origin never settles at all.
const OLLAMA_BASE_URL = 'http://localhost:11434';
const IS_LOCAL_PAGE = ['localhost', '127.0.0.1'].includes(location.hostname);
const OLLAMA_UNAVAILABLE_HOSTED_MSG =
	'Ollama only works when this app is run locally, not from the hosted site: browsers block a ' +
	'public page like this one from reaching a service on your own machine (Private Network Access) - ' +
	'this is a browser security rule, not something Ollama\'s settings can override. Run `python run.py` ' +
	'locally to use Ollama models.';

function fetchWithTimeout(url, options, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function listOllamaModels() {
	if (!IS_LOCAL_PAGE) throw new Error(OLLAMA_UNAVAILABLE_HOSTED_MSG);
	let res;
	try {
		res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 4000);
	} catch (e) {
		throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running.`);
	}
	if (!res.ok) throw new Error(`Ollama responded with ${res.status}`);
	const data = await res.json();
	return (data.models || []).map(m => m.name);
}

// Calls Ollama directly from the browser and normalizes the response into
// the same { content: [{ text }] } shape the rest of the chat code expects
// from the server-proxied backends.
async function callOllamaDirect(systemPrompt, chatMessages, model, maxTokens = 16384) {
	if (!IS_LOCAL_PAGE) throw new Error(OLLAMA_UNAVAILABLE_HOSTED_MSG);
	if (!model) throw new Error('No Ollama model selected.');
	let res;
	try {
		res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				stream: false,
				options: { num_predict: maxTokens },
				messages: [{ role: 'system', content: systemPrompt }, ...chatMessages]
			})
		}, 120000); // generous - local inference can be slow, especially cold-loading a model
	} catch (networkErr) {
		throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running.`);
	}
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`Ollama returned non-JSON (${res.status}): ${text.slice(0, 150)}`);
	}
	if (!res.ok) throw new Error(data.error || `Ollama error: ${res.status}`);
	return { content: [{ text: data.message?.content || '' }] };
}
let keyboardShift = false;    // uppercase next character key
let keyboardSymbols = false;  // symbol layer toggled on
// VR windows (vrWindows.js). Every in-headset window is a live DOM element
// painted by htmlInCanvas.js: the menu (#desktop-chat), the keyboard
// (#gs-vr-keyboard) and the head-locked Hide/Show UI button (#gs-vr-hud).
// Created in initVrWindows(); null until then.
let vrWindows = null;
let vrMainWindow = null;
let photoCapture = null; // 📷 camera preview (photoCapture.js), set up with the chat input
let vrKeyboardWindow = null;
let vrHudWindow = null;
let vrDialogWindow = null;   // in-app dialog (gsDialog.js) as a VR window
let vrKeyboardOpen = false;   // keyboard window shown (a text field was pointed at)
let vrKeyboardTarget = null;  // the <input>/<textarea> the VR keyboard types into
let rayVisible = true;        // controller ray lines shown (cursor always shows)
let uiCollapsed = false;      // all main panels hidden for an unobstructed scene

// Menu light: a point light just above the VR menu window (a child of
// panelAnchor, so it follows the menu in Fixed and Follow modes) that lights
// the menu's surroundings and the user's immediate area in dark scenes. The
// windows themselves are unlit (MeshBasicMaterial, toneMapped: false, fog:
// false), so they read the same in any lighting; the light is for the space
// around them. No shadows (Quest). Added on sessionstart, removed on
// sessionend; while the menu is hidden in XR its intensity is 0 instead of
// toggling visibility, because changing the number of lights recompiles
// every lit material (a hitch on Quest). Lives under panelAnchor, a system
// object, so Clear scene / exports / saved scenes never see it; also tagged
// gsNoExport for the 3D exporters.
const VR_MENU_LIGHT_INTENSITY = 1.6; // candela (physically based lights, three r180)
const VR_MENU_LIGHT_DISTANCE = 4;    // metres: menu, floor and the user, not the whole scene
const VR_MENU_LIGHT_ABOVE = 0.18;    // metres above the menu's top edge
const VR_MENU_LIGHT_FORWARD = 0.3;   // metres toward the user, so it lights the menu's front side
const vrMenuLight = new THREE.PointLight(0xfff4e0, VR_MENU_LIGHT_INTENSITY, VR_MENU_LIGHT_DISTANCE, 2);
vrMenuLight.name = 'gsMenuLight';
vrMenuLight.castShadow = false;
vrMenuLight.userData.gsNoExport = true;
vrMenuLight.userData.gsSystem = true;

let player = null;            // rig holding the camera + controllers (locomotion)
let viewOffset = null;        // child of player holding camera + controllers (identity transform)
let locomotionMode = 'free';  // 'off' (thumbsticks scroll) | 'planar' (First Person) | 'free' (WASD) - see dchat-nav-type
let _locoPrevTime = 0;        // previous frame timestamp for dt

// Speech-to-text (in-browser Whisper via transformers.js — cross-platform)
let speechSupported = false;   // getUserMedia + MediaRecorder available
let micMode = 'off';           // 'off' | 'always' | 'ptt' (see micListening for live capture)
let pttHand = null;            // handedness that started push-to-talk
let sttPipelinePromise = null; // lazy-loaded Whisper ASR pipeline (Promise)
let sttModelReady = false;     // model finished loading at least once
let micStream = null;          // active getUserMedia MediaStream
let mediaRecorder = null;      // MediaRecorder for the current utterance
let sttBusy = false;           // a transcription is in flight
let vadContext = null;         // AudioContext used for voice-activity detection
let vadAnalyser = null;        // AnalyserNode sampled each frame from the XR loop
let vadData = null;            // reusable Float32Array for analyser samples
let vadSpeaking = false;       // VAD currently hears speech
let vadSilenceMs = 0;          // ms of trailing silence after speech
let vadLastTime = 0;           // timestamp of last VAD tick
let isVRMode = true;
let vrBgHue = 220;       // 0-360
let vrBgSat = 0.15;      // 0-1
let vrBgLight = 0.12;    // 0-1
let vrSkybox = null;     // inverted sphere to block passthrough in VR mode
let executedCodeBlocks = [];  // vr-exec code blocks from current chat session
// The one scene in the world. null = a blank scene (chat-built code only).
// { id, name, thumbnail, codeBlocks, createdAt, mergedFrom?, community*? }.
// Loading any scene replaces it (see replaceActiveScene); there is no list of
// stacked scenes. Chat history belongs to it and is reset with it.
let activeScene = null;
// Bumped every time the active scene is replaced; async work (community
// fetches, chat replies) started for an older scene checks it and drops out.
let sceneEpoch = 0;
let sceneFileExtension = 'vrscene';
let scenePanelSubTab = 'scenes'; // 'scenes' | 'files' | 'code' | 'community' - see SCENE_PANEL_SUB_TABS
let communityScenesCache = []; // last-fetched list
let communityThemesCache = [];
let communitySection = 'scenes'; // Community tab: 'scenes' | 'themes'
// In-flight fetches keyed by communityKey so spam-clicks share one apply.
const communityLoadInflight = new Map();
// Bumped by every Community click and every scene change; a fetch that lands
// with an older ticket is dropped (see loadCommunityScene).
let communityLoadTicket = 0;
// Applies run one at a time so two loads can't scene.add while the other is still executing.
let communityApplyChain = Promise.resolve();
let chatSection = 'scene'; // Chat tab: 'scene' | 'theme' | 'prompt'
let displayOnlyMode = false; // share URL opened with editor chrome stripped
let pendingShare = null; // share modal payload { id, name, editorUrl, viewUrl }
// Community upload: "Allow others to export this scene" (Community tab and
// Share tab checkboxes). Starts at Allow on every page load.
let uploadAllowExport = true;
let embedRoute = null; // { sceneId, vr } on /embed/:id (see bootSharedScene)
let codeEditorDirty = false; // user has unsaved edits in Code tab
let codeHighlightApi = null; // set when Code tab highlight layer mounts
// HDRI state (textures filled later by initHdriControls; checked in applyEnvironmentMode)
let hdriEquirect = null;
let hdriPMREM = null;
let hdriObjectUrl = null;
let hdriPersistUrl = null;
let hdriUseAsBackground = true;
let hdriCurrentUrl = null; // http(s) or /api/... URL of the active HDRI (null for a local file)
let hdriFormat = null; // 'hdr' | 'exr' | 'image' of the active HDRI
let hdriLocalFile = null; // File picked from this computer (uploaded with Community scenes)
let hdriSceneDesc = null; // environmentHdri of the scene that set the active HDRI, else null
let hdriApplySeq = 0; // newest applyHdriFromUrl call wins
let pmremGenerator = null;
const HDRI_URL_STORAGE_KEY = 'gs-hdri-url';
let codeEditorApplying = false;
let codeEditorLiveTimer = null;
let codeEditorLastApplied = ''; // last successfully applied / synced source
const CODE_EDITOR_LIVE_DEBOUNCE_MS = 500;

let pendingRename = null;
let pendingRenameKind = 'scene'; // 'scene' | 'theme'
let currentTheme = null; // last applied theme object { name, cssVars, customCSS }
let themeChatMessages = []; // API context for /api/theme-chat
let themeChatLoading = false;
let systemObjectIds = new Set();
let systemOverlayIds = new Set();

// ============================================================================
// Expose globals for vr-exec code injection
// ============================================================================
window.THREE = THREE;
window.scene = scene;
window.camera = camera;
window.renderer = renderer;
window._vrAnimations = [];
// Canvas surfaces made by gsCreateCanvasSurface / gsCreateP5Surface (see the
// Environment + Dependencies section); disposed when the scene is cleared.
const gsSurfaces = new Set();

// Head-locked anchor for HUD elements the user *explicitly* asks to follow them.
// It is a child of the camera, so its origin matches the camera's translation.
const hud = new THREE.Group();
hud.name = 'hud';
camera.add(hud);

// Player rig ("dolly"): the camera (and, later, the controllers) ride inside it.
// Moving/rotating this group is the WebXR-correct way to move the user — three.js
// composes the rig's transform with the live headset pose. The camera must be in
// the scene graph for the HUD's children to render, which it now is via `player`.
// viewOffset sits between player and camera/controllers. It stays the identity
// (the old lay-down pitch was removed); injected scene code may still use it.
player = new THREE.Group();
player.name = 'player';
viewOffset = new THREE.Group();
viewOffset.name = 'viewOffset';
viewOffset.add(camera);
player.add(viewOffset);
scene.add(player);

window.hud = hud;

// World-anchored content root used in Walk-in-AR: scene content sits here on a
// ground plane and can be dragged with a finger. Outside AR it stays at origin
// and is unused (content lives directly under `scene`).
const arPlacementRoot = new THREE.Group();
arPlacementRoot.name = 'arPlacementRoot';
scene.add(arPlacementRoot);
window.arPlacementRoot = arPlacementRoot;

// Origin rotation (Environment tab, originGizmo.js): the frame the scene's
// content lives in. It sits at the origin inside arPlacementRoot, so Walk-in-AR
// still moves it as a whole. While it is rotated, everything scene code adds to
// `scene` is moved in here every frame (keeping its local transform, so code
// keeps working in scene coordinates); the player rig, panels, system lights
// and `hud` stay outside. Identity rotation leaves content directly under `scene`.
const gsOriginRoot = new THREE.Group();
gsOriginRoot.name = 'gsOriginRoot';
arPlacementRoot.add(gsOriginRoot);
window.gsOriginRoot = gsOriginRoot;
let originRotation = null; // createOriginRotation(), set up with the Environment tab below
// Scene code removes with scene.remove(obj); that must still work for objects
// that were moved into the origin / AR placement group.
{
	const sceneRemove = scene.remove;
	scene.remove = function (...objects) {
		for (const o of objects) {
			if (o && o.parent && o.parent !== this && (o.parent === gsOriginRoot || o.parent === arPlacementRoot)) o.parent.remove(o);
			else sceneRemove.call(this, o);
		}
		return this;
	};
}

let arPlacementMarker = null; // subtle ring shown only in Walk-in-AR
let arDragging = false;
let arDragPointerId = null;
const _arGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _arRaycaster = new THREE.Raycaster();
const _arNdc = new THREE.Vector2();
const _arHit = new THREE.Vector3();
const _arLastHit = new THREE.Vector3();
const _arFwd = new THREE.Vector3();
const _arCamPos = new THREE.Vector3();

// ============================================================================
// XR Button Setup — immersive-vr or immersive-ar, picked by the AR / VR
// toggle next to it (Cardboard is separate, below).
// ============================================================================
// AR / VR mode. 'ar' = immersive-ar: the real room (Quest 3 passthrough, an
// ARCore phone's camera) behind the scene, so the colour skybox, the HDRI
// background and scene sky domes are hidden while it is on. 'vr' =
// immersive-vr with the colour skybox. Unsupported modes are disabled; the
// choice is remembered (gs.xrMode).
const XR_MODE_KEY = 'gs.xrMode';
let xrModePref = 'vr';
try { if (localStorage.getItem(XR_MODE_KEY) === 'ar') xrModePref = 'ar'; } catch { /* storage blocked */ }
const xrModeSupport = { vr: null, ar: null }; // null = still asking
let xrSessionMode = null; // 'immersive-vr' | 'immersive-ar' while presenting
let _xrSwitching = false; // a VR -> AR session switch is in flight (chooseXrMode)
const xrEntryButton = XRButton.createButton(renderer, {
	optionalFeatures: ['hit-test', 'dom-overlay'],
	domOverlay: { root: overlayRoot },
	getMode: () => (effectiveXrMode() === 'ar' ? 'immersive-ar' : 'immersive-vr'),
	onSupport: (sup) => { xrModeSupport.vr = !!sup.vr; xrModeSupport.ar = !!sup.ar; renderXrModeToggle(); renderDomEnv(); },
	onSessionMode: (mode) => { xrSessionMode = mode; }
});
if (!('xr' in navigator)) { xrModeSupport.vr = false; xrModeSupport.ar = false; }
// No-WebXR fallback is an <a> without an id; give it the same id for styling.
if (!xrEntryButton.id) xrEntryButton.id = 'XRButton';
// Lives in the window's top bar (#gs-dock in #desktop-chat-header), right
// before Exit VR (see index.html). Version and Cardboard are in Meta Settings.
const gsDock = document.getElementById('gs-dock');
if (gsDock) {
	gsDock.insertBefore(xrEntryButton, document.getElementById('gs-exit-vr-btn'));
} else {
	document.body.appendChild(xrEntryButton);
}
// AR | VR segmented toggle, right before Enter VR / Enter AR.
const xrModeToggle = document.createElement('div');
xrModeToggle.id = 'gs-xr-mode';
xrModeToggle.setAttribute('role', 'radiogroup');
xrModeToggle.setAttribute('aria-label', 'Immersive mode');
xrModeToggle.hidden = true;
for (const [id, text, title] of [['ar', 'AR', 'Augmented reality: your room (passthrough) behind the scene'], ['vr', 'VR', 'Virtual reality: the scene with a colour sky']]) {
	const b = document.createElement('button');
	b.type = 'button';
	b.dataset.xrMode = id;
	b.setAttribute('role', 'radio');
	b.textContent = text;
	b.title = title;
	b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); chooseXrMode(id); });
	xrModeToggle.appendChild(b);
}
xrEntryButton.parentNode.insertBefore(xrModeToggle, xrEntryButton);
// The mode Enter will start: the saved choice when this device supports it,
// else the one it does support.
function effectiveXrMode() {
	const { vr, ar } = xrModeSupport;
	if (xrModePref === 'ar') return ar === false && vr ? 'vr' : 'ar';
	return vr === false && ar ? 'ar' : 'vr';
}
// What the toggle shows as selected: inside a session, what you see now (an
// AR session shows the room, or the colour sky after "VR"); otherwise the
// mode Enter will start.
function currentXrModeShown() {
	if (renderer && renderer.xr && renderer.xr.isPresenting && xrSessionMode) {
		return xrSessionMode === 'immersive-ar' && !isVRMode ? 'ar' : 'vr';
	}
	return effectiveXrMode();
}
function renderXrModeToggle() {
	const known = xrModeSupport.vr !== null;
	xrModeToggle.hidden = !known || (!xrModeSupport.vr && !xrModeSupport.ar);
	const eff = currentXrModeShown();
	xrModeToggle.dataset.active = eff;
	xrModeToggle.classList.toggle('gs-xr-switching', _xrSwitching);
	for (const b of xrModeToggle.querySelectorAll('button')) {
		const id = b.dataset.xrMode;
		const ok = !!xrModeSupport[id];
		b.disabled = !ok;
		b.setAttribute('aria-checked', String(ok && id === eff));
		b.title = ok ? b.title.replace(/ \(not supported.*\)$/, '') : b.title.replace(/ \(not supported.*\)$/, '') + ` (not supported on this device/browser)`;
	}
	if (xrEntryButton.gsRefreshMode) xrEntryButton.gsRefreshMode();
}
function setXrModePref(mode) {
	if (mode !== 'ar' && mode !== 'vr') return;
	if (xrModeSupport[mode] === false) {
		updateStatus(mode === 'ar' ? 'AR (passthrough) isn’t supported on this device' : 'VR isn’t supported on this device', 'error');
		renderXrModeToggle();
		return;
	}
	xrModePref = mode;
	try { localStorage.setItem(XR_MODE_KEY, mode); } catch { /* storage blocked */ }
	renderXrModeToggle();
	renderDomEnv();
}
// AR | VR choice from the top-bar toggle or the Env tab (desktop, phone and
// the VR menu, which is the same DOM painted into the headset).
//  - Not in a session: remember it; Enter starts that mode.
//  - In an immersive-ar session: switch live. "VR" covers the room with the
//    colour sky, "AR" shows the room again. No new session, so no headset
//    fade, no permission prompt, nothing to go wrong.
//  - In an immersive-vr session, "AR": a VR session can't show passthrough
//    and the mode is fixed at requestSession, so end it and start
//    immersive-ar straight away (the controller click is the user gesture).
//    If the browser refuses (no gesture left, permission, not supported), the
//    choice is kept and an in-app dialog offers one tap to enter it.
function chooseXrMode(mode) {
	if (mode !== 'ar' && mode !== 'vr') return;
	const session = renderer && renderer.xr && renderer.xr.isPresenting ? xrSessionMode : null;
	if (!session) { setXrModePref(mode); return; }
	if (_xrSwitching) return;
	if (xrModeSupport[mode] === false) {
		gsAlert(mode === 'ar'
			? 'AR (passthrough) isn’t supported on this headset or browser, so GS stays in VR.'
			: 'VR isn’t supported on this headset or browser.', { title: 'Can’t switch mode' });
		return;
	}
	setXrModePref(mode);
	if (session === 'immersive-ar') {
		isVRMode = mode === 'vr';
		updateStatus(mode === 'vr' ? 'VR: colour sky' : 'AR: passthrough', 'connected');
		applyEnvironmentMode();
		renderDomEnv();
		renderXrModeToggle();
		return;
	}
	if (mode === 'vr') { renderXrModeToggle(); return; } // already in VR
	switchXrSession('immersive-ar');
}
async function switchXrSession(mode) {
	const name = mode === 'immersive-ar' ? 'AR' : 'VR';
	_xrSwitching = true;
	renderXrModeToggle();
	updateStatus(`Switching to ${name}…`, '');
	try {
		await xrEntryButton.gsSwitchTo(mode);
		updateStatus(`${name} started`, 'connected');
	} catch (err) {
		console.warn(`Switch to ${name} failed:`, err);
		const unsupported = err && err.name === 'NotSupportedError';
		if (unsupported) {
			if (mode === 'immersive-ar') xrModeSupport.ar = false;
			setXrModePref(mode === 'immersive-ar' ? 'vr' : 'ar');
		}
		_xrSwitching = false;
		renderXrModeToggle();
		renderDomEnv();
		const back = effectiveXrMode() === 'ar' ? 'AR' : 'VR';
		const presentingNow = renderer.xr.isPresenting;
		if (presentingNow) { updateStatus(`Couldn’t switch to ${name}`, 'error'); return; }
		// The old session has ended, so this is the normal page dialog; its
		// button is a real tap, which requestSession accepts.
		const ok = await gsConfirm(unsupported
			? `This headset or browser couldn’t start ${name}${err.message ? ` (${err.message})` : ''}. Go back into ${back}?`
			: `Switching to ${name} needs one more tap: the browser didn’t let GS start it straight away. ${name} is selected, so Enter ${name} starts it.`,
			{ title: `Switch to ${name}`, okLabel: `Enter ${back}`, cancelLabel: 'Not now' });
		if (ok && !renderer.xr.isPresenting) xrEntryButton.click();
	} finally {
		_xrSwitching = false;
		renderXrModeToggle();
	}
}
renderXrModeToggle();
window.gsXrMode = {
	get preferred() { return xrModePref; },
	get effective() { return effectiveXrMode(); },
	get support() { return { ...xrModeSupport }; },
	get session() { return xrSessionMode; },
	get passthrough() { return arPassthroughActive(); },
	get switching() { return _xrSwitching; },
	set: setXrModePref,
	choose: chooseXrMode
};

// Exit VR: shown only inside a VR session, in the same top bar, which is the
// top of the VR menu (CSS: body.gs-xr-presenting #gs-exit-vr-btn). One press
// ends the session; sessionend brings the desktop view back.
document.getElementById('gs-exit-vr-btn')?.addEventListener('click', (e) => {
	e.preventDefault();
	e.stopPropagation();
	exitXrToDesktop();
});
// XRButton rewrites textContent (ENTER VR / EXIT VR / VR NOT SUPPORTED);
// mirror that into data-xr-state so the dock can style usable vs. not.
function syncXrEntryButtonState() {
	const t = (xrEntryButton.textContent || '').toLowerCase();
	xrEntryButton.dataset.xrState = t.includes('exit') ? 'exit' : t.includes('enter') ? 'enter' : 'unavailable';
}
syncXrEntryButtonState();
new MutationObserver(syncXrEntryButtonState).observe(xrEntryButton, { childList: true, characterData: true, subtree: true });

// ============================================================================
// Mobile pseudo-XR: Google Cardboard (stereo + gyro) for phones that can't
// do immersive-vr (iPhone Safari has no WebXR; some Android browsers don't
// either). No 6DOF. Gyro matches look to the phone. Hold-to-walk nudges the
// camera; touch never orbits/rotates the view. AR / Walk-in-AR is not offered.
// ============================================================================
let mobileXRMode = null; // null | 'cardboard'
let mobileMoveHeld = false;
let arVideoStream = null;
const stereoCam = new THREE.StereoCamera();
stereoCam.eyeSep = 0.064; // average human interpupillary distance, metres

const cardboardBtn = document.getElementById('cardboard-btn');
const mobileXRExitBtn = document.getElementById('mobile-xr-exit');
const mobileXRWalkBtn = document.getElementById('mobile-xr-walk');
const mobileXrGizmoBar = document.getElementById('mobile-xr-gizmo-bar');
const mobileXrGizmoToggle = document.getElementById('mobile-xr-gizmo-toggle');
const mobileXrGizmoModes = document.getElementById('mobile-xr-gizmo-modes');
const mobileXrGizmoAll = document.getElementById('mobile-xr-gizmo-all');
const mobileXrGizmoTranslate = document.getElementById('mobile-xr-gizmo-translate');
const mobileXrGizmoRotate = document.getElementById('mobile-xr-gizmo-rotate');
const mobileXrGizmoScale = document.getElementById('mobile-xr-gizmo-scale');
const arVideoEl = document.getElementById('ar-camera-feed');

const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Cardboard only when immersive-vr isn't available. immersive-ar is not checked.
async function refreshMobileXRButtons() {
	if (!cardboardBtn) return;
	if (!isMobileUA || mobileXRMode) {
		cardboardBtn.hidden = true;
		return;
	}
	let vrOk = false;
	if ('xr' in navigator) {
		try { vrOk = await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* unsupported */ }
	}
	cardboardBtn.hidden = vrOk;
	const note = document.getElementById('dchat-meta-cardboard-note');
	if (note) note.hidden = !cardboardBtn.hidden;
}

// Keep the Cardboard close X above the canvas, chat window, and modals.
function raiseMobileXRExitButton() {
	if (!mobileXRExitBtn) return;
	mobileXRExitBtn.style.zIndex = '2147483647';
	mobileXRExitBtn.style.pointerEvents = 'auto';
	document.body.appendChild(mobileXRExitBtn);
}
refreshMobileXRButtons();

// --- Device orientation → camera rotation (standard three.js algorithm) ---
const _doZee = new THREE.Vector3(0, 0, 1);
const _doEuler = new THREE.Euler();
const _doQ0 = new THREE.Quaternion();
const _doQ1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X
let _doAlpha = 0, _doBeta = 0, _doGamma = 0, _doOrient = 0;

function onDeviceOrientation(e) {
	_doAlpha = THREE.MathUtils.degToRad(e.alpha || 0);
	_doBeta = THREE.MathUtils.degToRad(e.beta || 0);
	_doGamma = THREE.MathUtils.degToRad(e.gamma || 0);
}
function onScreenOrientationChange() {
	_doOrient = (screen.orientation && typeof screen.orientation.angle === 'number')
		? THREE.MathUtils.degToRad(screen.orientation.angle)
		: 0;
}
function updateCameraFromDeviceOrientation() {
	_doEuler.set(_doBeta, _doAlpha, -_doGamma, 'YXZ');
	camera.quaternion.setFromEuler(_doEuler);
	camera.quaternion.multiply(_doQ1);
	camera.quaternion.multiply(_doQ0.setFromAxisAngle(_doZee, -_doOrient));
}

// iOS 13+ requires an explicit user-gesture-triggered permission prompt for
// motion/orientation events; every other platform just works.
async function requestDeviceOrientationPermission() {
	if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
		try {
			return (await DeviceOrientationEvent.requestPermission()) === 'granted';
		} catch (err) {
			console.error('Device orientation permission error:', err);
			return false;
		}
	}
	return true;
}

function ensureArPlacementMarker() {
	if (arPlacementMarker) return arPlacementMarker;
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(0.28, 0.34, 48),
		new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.55,
			side: THREE.DoubleSide,
			depthWrite: false
		})
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.01;
	ring.name = 'arPlacementMarker';
	ring.renderOrder = 5;
	arPlacementRoot.add(ring);
	arPlacementMarker = ring;
	return ring;
}

function isArUiTouchTarget(target) {
	if (!target || !target.closest) return false;
	return !!(
		target.closest('#mobile-xr-exit') ||
		target.closest('#mobile-xr-walk') ||
		target.closest('#mobile-xr-gizmo-bar') ||
		target.closest('#desktop-chat') ||
		target.closest('#files-picker-modal') ||
		target.closest('#export-modal') ||
		target.closest('#share-modal') ||
		target.closest('#rename-modal') ||
		target.closest('#gs-dialog-root') ||
		target.closest('#XRButton') ||
		target.closest('#gs-dock') ||
		target.closest('.mobile-xr-btn')
	);
}

function raycastGround(clientX, clientY, out) {
	_arNdc.x = (clientX / window.innerWidth) * 2 - 1;
	_arNdc.y = -(clientY / window.innerHeight) * 2 + 1;
	_arRaycaster.setFromCamera(_arNdc, camera);
	return _arRaycaster.ray.intersectPlane(_arGroundPlane, out) !== null;
}

/** Parent for world content: the origin root while it is rotated or Walk-in-AR is active. */
function getWorldContentParent() {
	return mobileXRMode === 'ar' || originRotationActive() ? gsOriginRoot : scene;
}

function originRotationActive() {
	return !!originRotation && !originRotation.isIdentity();
}

/** Every top-level user object: under the scene root, the AR placement group
 *  and the origin root (clear, export, hot-reload attribution all use this). */
function userContentRoots() {
	const out = [];
	for (const child of scene.children) {
		if (child === player || child === arPlacementRoot || systemObjectIds.has(child.uuid)) continue;
		out.push(child);
	}
	for (const parent of [arPlacementRoot, gsOriginRoot]) {
		for (const child of parent.children) {
			if (child === arPlacementMarker || child === gsOriginRoot || systemObjectIds.has(child.uuid)) continue;
			out.push(child);
		}
	}
	return out;
}

/** Move scene-root content into the (rotated) origin root, keeping each
 *  object's local transform: scene code places things in scene coordinates,
 *  so they land where the code meant inside the rotated frame. */
function adoptSceneContentIntoOrigin() {
	for (const child of gatherMovableSceneRoots()) {
		if (child.userData && child.userData.gsWorldLocked) continue;
		if (menuPriorityRoots.includes(child)) continue;
		gsOriginRoot.add(child);
	}
}

function gatherMovableSceneRoots() {
	const roots = [];
	for (const child of [...scene.children]) {
		if (child === player || child === arPlacementRoot) continue;
		if (arGizmoHelpers.includes(child)) continue;
		if (systemObjectIds.has(child.uuid)) continue;
		roots.push(child);
	}
	// Also pull any user content that somehow stayed under scene while marker/root exist
	return roots;
}

function adoptSceneContentIntoArPlacement() {
	for (const child of gatherMovableSceneRoots()) {
		gsOriginRoot.attach(child);
	}
}

function releaseArPlacementContentToScene() {
	for (const child of [...arPlacementRoot.children]) {
		if (child === arPlacementMarker || child === gsOriginRoot) continue;
		scene.attach(child);
	}
	// A rotated origin keeps its content (it is the scene's frame); otherwise
	// hand it back to the scene root where the AR placement left it.
	if (!originRotationActive()) {
		for (const child of [...gsOriginRoot.children]) scene.attach(child);
	}
}

function placeArAnchorInFrontOfCamera(distance = 1.6) {
	camera.getWorldPosition(_arCamPos);
	camera.getWorldDirection(_arFwd);
	_arFwd.y = 0;
	if (_arFwd.lengthSq() < 1e-6) _arFwd.set(0, 0, -1);
	_arFwd.normalize();
	arPlacementRoot.position.set(
		_arCamPos.x + _arFwd.x * distance,
		0,
		_arCamPos.z + _arFwd.z * distance
	);
	// Keep yaw so the scene faces the user
	arPlacementRoot.rotation.set(0, Math.atan2(_arFwd.x, _arFwd.z), 0);
}

function applyArGizmoAttachment() {
	for (const [mode, ctrl] of Object.entries(arTransformByMode)) {
		const helper = ctrl.getHelper();
		const want = arGizmoVisible && (arGizmoMode === 'all' || arGizmoMode === mode);
		if (want) {
			ctrl.attach(arPlacementRoot);
			ctrl.enabled = !arGizmoDragging || ctrl.dragging;
			ctrl.showX = true;
			ctrl.showY = true;
			ctrl.showZ = true;
			helper.visible = true;
		} else {
			ctrl.detach();
			ctrl.enabled = false;
			helper.visible = false;
		}
	}
}

function setArGizmoVisible(visible) {
	// Smartphones/tablets Walk-in-AR only — never in WebXR.
	if (renderer.xr.isPresenting || mobileXRMode !== 'ar') visible = false;
	arGizmoVisible = !!visible;
	if (!arGizmoVisible) arGizmoDragging = false;
	applyArGizmoAttachment();
	if (mobileXrGizmoToggle) {
		mobileXrGizmoToggle.textContent = arGizmoVisible ? 'Hide Gizmo' : 'Show Gizmo';
		mobileXrGizmoToggle.classList.toggle('active', arGizmoVisible);
	}
	if (mobileXrGizmoModes) mobileXrGizmoModes.classList.toggle('visible', arGizmoVisible);
}

function setArGizmoMode(mode) {
	const m = (mode === 'all' || mode === 'rotate' || mode === 'scale') ? mode : 'translate';
	arGizmoMode = m;
	applyArGizmoAttachment();
	for (const btn of [mobileXrGizmoAll, mobileXrGizmoTranslate, mobileXrGizmoRotate, mobileXrGizmoScale]) {
		if (!btn) continue;
		btn.classList.toggle('active', btn.dataset.mode === m);
	}
}

function setArPlacementActive(active) {
	ensureArPlacementMarker();
	if (arPlacementMarker) arPlacementMarker.visible = !!active;
	if (active) {
		adoptSceneContentIntoArPlacement();
		placeArAnchorInFrontOfCamera();
		// Touch must move the scene, never orbit/pan the camera (controls are
		// suspended while mobileXRMode is set).
		refreshCameraControls();
		renderer.domElement.style.touchAction = 'none';
		if (mobileXrGizmoBar) mobileXrGizmoBar.classList.add('visible');
		setArGizmoMode('all');
		setArGizmoVisible(true);
	} else {
		setArGizmoVisible(false);
		if (mobileXrGizmoBar) mobileXrGizmoBar.classList.remove('visible');
		releaseArPlacementContentToScene();
		arPlacementRoot.position.set(0, 0, 0);
		arPlacementRoot.rotation.set(0, 0, 0);
		arPlacementRoot.scale.set(1, 1, 1);
		arDragging = false;
		arDragPointerId = null;
		refreshCameraControls();
		renderer.domElement.style.touchAction = 'none';
	}
}

function onArPointerDown(e) {
	if (mobileXRMode !== 'ar' || renderer.xr.isPresenting) return;
	if (isArUiTouchTarget(e.target)) return;
	// When the transform gizmo is shown, placement goes through gizmo handles —
	// free ground drag is off so it doesn't fight axis grabs.
	if (arGizmoVisible || arGizmoDragging) return;
	if (!raycastGround(e.clientX, e.clientY, _arLastHit)) return;
	arDragging = true;
	arDragPointerId = e.pointerId;
	try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
	e.preventDefault();
}

function onArPointerMove(e) {
	if (!arDragging || mobileXRMode !== 'ar') return;
	if (arDragPointerId != null && e.pointerId !== arDragPointerId) return;
	if (!raycastGround(e.clientX, e.clientY, _arHit)) return;
	const dx = _arHit.x - _arLastHit.x;
	const dz = _arHit.z - _arLastHit.z;
	arPlacementRoot.position.x += dx;
	arPlacementRoot.position.z += dz;
	_arLastHit.copy(_arHit);
	e.preventDefault();
}

function onArPointerUp(e) {
	if (!arDragging) return;
	if (arDragPointerId != null && e.pointerId !== arDragPointerId) return;
	arDragging = false;
	arDragPointerId = null;
}

renderer.domElement.addEventListener('pointerdown', onArPointerDown, { passive: false });
renderer.domElement.addEventListener('pointermove', onArPointerMove, { passive: false });
renderer.domElement.addEventListener('pointerup', onArPointerUp);
renderer.domElement.addEventListener('pointercancel', onArPointerUp);
renderer.domElement.addEventListener('pointerleave', onArPointerUp);

async function enterMobileXRMode(mode) {
	// AR / Walk-in-AR entry removed. Cardboard only.
	if (mode !== 'cardboard') return;

	const granted = await requestDeviceOrientationPermission();
	if (!granted) {
		updateStatus('Motion access denied - needed to look around', 'error');
		return;
	}

	isVRMode = true;

	window.addEventListener('deviceorientation', onDeviceOrientation);
	window.addEventListener('orientationchange', onScreenOrientationChange);
	onScreenOrientationChange();

	try { await document.documentElement.requestFullscreen(); } catch { /* best-effort */ }
	if (screen.orientation && screen.orientation.lock) {
		try { await screen.orientation.lock('landscape'); } catch { /* not all browsers allow this */ }
	}

	mobileXRMode = 'cardboard';
	refreshCameraControls();
	document.body.classList.add('gs-cardboard-active');
	if (cardboardBtn) cardboardBtn.hidden = true;
	mobileXRExitBtn.hidden = false;
	raiseMobileXRExitButton();
	mobileXRWalkBtn.hidden = false;
	updateStatus('Cardboard VR active', 'connected');
	applyEnvironmentMode();
	renderDomEnv();
}

function exitMobileXRMode() {
	if (!mobileXRMode) return;

	window.removeEventListener('deviceorientation', onDeviceOrientation);
	window.removeEventListener('orientationchange', onScreenOrientationChange);

	if (arVideoStream) {
		for (const track of arVideoStream.getTracks()) track.stop();
		arVideoStream = null;
	}
	if (arVideoEl) {
		arVideoEl.classList.remove('active');
		arVideoEl.srcObject = null;
	}

	if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	if (screen.orientation && screen.orientation.unlock) {
		try { screen.orientation.unlock(); } catch { /* ignore */ }
	}

	const wasAr = mobileXRMode === 'ar';
	mobileXRMode = null;
	document.body.classList.remove('gs-cardboard-active');
	mobileMoveHeld = false;
	if (wasAr) setArPlacementActive(false);
	refreshCameraControls();
	resetCameraView(); // back to the default desktop view
	mobileXRExitBtn.hidden = true;
	mobileXRWalkBtn.hidden = true;
	isVRMode = true;
	applyEnvironmentMode();
	renderDomEnv();
	updateStatus('Ready', '');
	refreshMobileXRButtons();
}

cardboardBtn.addEventListener('click', () => enterMobileXRMode('cardboard'));
mobileXRExitBtn.addEventListener('click', exitMobileXRMode);
raiseMobileXRExitButton();

// touchstart/touchend (mobile) and mousedown/mouseup (desktop testing) both
// wired so this works whether it's a real touchscreen or a mouse.
mobileXRWalkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); mobileMoveHeld = true; });
mobileXRWalkBtn.addEventListener('touchend', (e) => { e.preventDefault(); mobileMoveHeld = false; });
mobileXRWalkBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); mobileMoveHeld = false; });
mobileXRWalkBtn.addEventListener('mousedown', () => { mobileMoveHeld = true; });
mobileXRWalkBtn.addEventListener('mouseup', () => { mobileMoveHeld = false; });
mobileXRWalkBtn.addEventListener('mouseleave', () => { mobileMoveHeld = false; });

mobileXrGizmoToggle?.addEventListener('click', () => {
	if (mobileXRMode !== 'ar' || renderer.xr.isPresenting) return;
	setArGizmoVisible(!arGizmoVisible);
});
mobileXrGizmoAll?.addEventListener('click', () => setArGizmoMode('all'));
mobileXrGizmoTranslate?.addEventListener('click', () => setArGizmoMode('translate'));
mobileXrGizmoRotate?.addEventListener('click', () => setArGizmoMode('rotate'));
mobileXrGizmoScale?.addEventListener('click', () => setArGizmoMode('scale'));


// ============================================================================
// Lighting
// ============================================================================
// Named so AI scene code can find and dim them (see the photorealistic
// lighting section of SYSTEM_PROMPT in server.js).
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
ambientLight.name = 'gsDefaultAmbient';
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.name = 'gsDefaultKey';
directionalLight.position.set(0, 2, 1);
scene.add(directionalLight);

// VR skybox: large inverted sphere to block passthrough when in VR mode
const skyboxGeo = new THREE.SphereGeometry(50, 32, 16);
const skyboxMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x1a1a2e });
vrSkybox = new THREE.Mesh(skyboxGeo, skyboxMat);
vrSkybox.visible = false;
scene.add(vrSkybox);

// Renders the same message list into the desktop (non-XR) DOM chat window.
function renderDomChat() {
	if (!desktopChatMessages) return;

	desktopChatMessages.innerHTML = '';
	for (const msg of displayMessages) {
		const bubble = document.createElement('div');
		bubble.className = 'dchat-msg ' + (msg.role === 'user' ? 'user' : 'assistant');
		bubble.textContent = msg.content;
		if (msg.history) GSContext.decorateBubble(bubble, msg); // restored creation history
		desktopChatMessages.appendChild(bubble);
	}
	if (isLoading) {
		const thinking = document.createElement('div');
		thinking.className = 'dchat-msg thinking';
		thinking.textContent = thinkingStatusText();
		desktopChatMessages.appendChild(thinking);
	}
	desktopChatMessages.scrollTop = desktopChatMessages.scrollHeight;
}

// ============================================================================
// VR keyboard (in-scene text entry)
// ============================================================================
// The keyboard is a VR window like the menu: real <button>s in #gs-vr-keyboard,
// painted by htmlInCanvas.js and pressed with the controller ray. Pointing at a
// text field in the menu opens it; keys edit that field directly. The DOM field
// is never focused in XR, so the crashy Quest system keyboard is never summoned.
//
// Each row is laid out left-to-right; a key's `w` is a relative width weight. A
// plain string is a character key; an object declares a control key or a char key
// with a custom label.
const KB_ROWS_LETTERS = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
	['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
	['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
	[{ label: '⇧', action: 'shift', w: 1.5 }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', { label: '⌫', action: 'backspace', w: 1.5 }],
	[{ label: '?123', action: 'symbols', w: 2 }, { label: 'space', action: 'space', w: 5 }, '.', { label: 'Send', action: 'enter', w: 2 }]
];
const KB_ROWS_SYMBOLS = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
	['!', '@', '#', '$', '%', '&', '*', '(', ')', '/'],
	['-', '_', '=', '+', ':', ';', ',', '?', '\''],
	[{ label: '"', action: 'char' }, '[', ']', '{', '}', '<', '>', '~', { label: '⌫', action: 'backspace', w: 1.5 }],
	[{ label: 'abc', action: 'symbols', w: 2 }, { label: 'space', action: 'space', w: 5 }, '.', { label: 'Send', action: 'enter', w: 2 }]
];

function normalizeKey(key) {
	if (typeof key === 'string') {
		return { label: key, value: key, action: 'char', w: 1 };
	}
	return {
		label: key.label,
		value: key.value !== undefined ? key.value : key.label,
		action: key.action || 'char',
		w: key.w || 1
	};
}

// The chat field that speech-to-text and the VR keyboard's Send target: the
// Theme chat input when that sub-tab is showing, else the Scene chat input.
function activeChatField() {
	return chatSection === 'theme' && dchatThemeChatInput ? dchatThemeChatInput : desktopChatInput;
}

// Put dictated text into the active chat field (and the legacy hidden input).
function setInputText(text) {
	const field = activeChatField();
	if (field) {
		field.value = text;
		field.dispatchEvent(new Event('input', { bubbles: true }));
	}
	if (chatInput) chatInput.value = text;
}

// Send whatever is in the active chat field (VR keyboard Send / voice auto-send).
function sendActiveChatField() {
	if (chatSection === 'theme' && dchatThemeChatInput) sendThemeChat();
	else if (desktopSendButton) desktopSendButton.click();
}

// ============================================================================
// Pointer Ray Visibility Toggle
// ============================================================================
// Hide the ray *lines* for an unobstructed view while keeping the intersection
// cursor (reticle) so the user can still aim. Bound to the B/Y controller button.
function toggleRayVisibility() {
	rayVisible = !rayVisible;
	for (const ray of controllerRays) {
		if (ray) ray.visible = rayVisible;
	}
	updateStatus(rayVisible ? 'Pointer lines on' : 'Pointer lines off (cursor only)', '');
}

// ============================================================================
// Speech-to-Text (cross-platform: MediaRecorder + in-browser Whisper)
// ============================================================================
// The Web Speech API (SpeechRecognition) only exists in Chrome/Edge desktop, so
// it was dead on the Quest Browser, Firefox, and Safari. Instead we capture audio
// with getUserMedia + MediaRecorder (supported everywhere) and transcribe it
// locally in the browser with Whisper via transformers.js — no API key, no server
// round-trip, works on any platform with a mic and a secure context.
//   • Always-on: toggle the MIC button; a voice-activity detector segments speech
//     and each finished utterance is transcribed and auto-sent.
//   • Push-to-talk: hold the A/X controller button; the utterance is transcribed
//     and sent on release.
// Whisper runs in a Web Worker when it can (falls back to the main thread), so
// transcribing doesn't stall the VR frame loop.
// Every state (permission, model download %, listening, transcribing, blocked,
// errors) is shown in #gs-mic-status under the chat tools (desktop, phones and
// the VR menu, which mirrors #desktop-chat) and, short, in the VR HUD.
// #status stays hidden (the old top-right badge is gone for good).
// Requires a secure context (HTTPS or localhost) for mic access — the same
// requirement WebXR itself has — plus internet on first run to fetch the model.
const STT_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
const STT_MODEL = 'Xenova/whisper-tiny.en';
// Adaptive voice-activity detection: speech is energy well above a running
// noise floor, so a fan / headset hiss neither counts as speech nor keeps a
// segment open forever.
const VAD_MIN_THRESHOLD = 0.008;   // never treat less than this RMS as speech
const VAD_FLOOR_FACTOR = 2.0;      // speech threshold = floor * factor + margin
const VAD_FLOOR_MARGIN = 0.004;
const VAD_HOLD_RATIO = 0.7;        // once speaking, stay "speaking" down to 70% of the threshold
const VAD_SILENCE_MS = 800;        // trailing silence that ends an utterance
const VAD_MIN_SPEECH_MS = 200;     // shorter bursts (clicks, bumps) are dropped
const VAD_MAX_SEGMENT_MS = 15000;  // a segment is cut and sent after this long
const VAD_IDLE_ROTATE_MS = 5000;   // silent recording is restarted so segments stay short
const MIC_USED_KEY = 'gs.micUsed'; // set once the mic has worked; gates the Enter VR permission ask
const MIC_RELEASE_MS = 30000;      // keep the stream this long after push-to-talk for quick re-press
const MIC_PROMPT_HINT_MS = 7000;   // no answer to the permission ask by then: explain where to look
const IS_QUEST_BROWSER = /OculusBrowser|Quest/i.test(navigator.userAgent || '');

let micListening = false;     // recording is live (always-on VAD running, or PTT capturing)
let micReleaseTimer = null;
let sttRun = null;            // (Float32Array) => Promise<string>
let sttWorker = null;
let sttWorkerBroken = false;
let sttFiles = {};            // model download progress by file
let sttPct = 0;
let sttWaiting = 0;           // transcriptions waiting on the model (status stays visible)
let sttQueue = Promise.resolve();
let vadNoise = null;          // running noise-floor RMS
let vadSpeechMs = 0;
let vadSegStart = 0;
let micStatusTimer = null;
let micTransient = null;      // { state, text, hud } shown over the steady status
const micStats = { segments: 0, rotations: 0, lastSegmentMs: 0, dropped: 0 }; // read by test-harness/mic
const micStatusEl = document.getElementById('gs-mic-status');
const vrHudMicEl = document.getElementById('gs-vr-hud-mic');

function initSpeech() {
	speechSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// ---- status ---------------------------------------------------------------
function micInXr() {
	return !!(renderer && renderer.xr && renderer.xr.isPresenting);
}

// What to show when nothing transient is up: derived from the mic state.
function micSteadyStatus() {
	const loading = !sttModelReady && (micMode !== 'off' || sttWaiting > 0);
	const loadText = `Loading speech model… ${sttPct}%` + (sttTotalMb() ? ` of ${sttTotalMb()} MB` : '') + ' (first time only)';
	if (micMode === 'always') {
		if (micListening) return { state: 'listening', text: 'Listening — speak, then pause to send', hud: 'Listening' };
		if (loading) return { state: 'loading', text: loadText, hud: `Loading ${sttPct}%` };
		return { state: 'starting', text: 'Starting microphone…', hud: 'Starting…' };
	}
	if (micMode === 'ptt') {
		if (micListening && sttModelReady) return { state: 'listening', text: 'Listening — release to send', hud: 'Listening' };
		if (micListening) return { state: 'loading', text: loadText + ' — keep holding, then release', hud: `Loading ${sttPct}%` };
		return { state: 'starting', text: 'Starting microphone…', hud: 'Starting…' };
	}
	if (loading) return { state: 'loading', text: loadText, hud: `Loading ${sttPct}%` };
	return { state: 'idle', text: '', hud: '' };
}

function renderMicStatus() {
	const s = micTransient || micSteadyStatus();
	if (micStatusEl) {
		micStatusEl.textContent = s.text || '';
		micStatusEl.hidden = !s.text;
		micStatusEl.dataset.state = s.state;
	}
	if (vrHudMicEl) {
		vrHudMicEl.textContent = s.hud ? '🎤 ' + s.hud : '';
		vrHudMicEl.hidden = !s.hud;
		vrHudMicEl.dataset.state = s.state;
	}
}

// Show a transient message (transcribing, info, errors) over the steady status.
// autoHideMs: back to the steady status after that long (0 = until replaced).
function setMicStatus(state, text, { hud = null, autoHideMs = 0 } = {}) {
	clearTimeout(micStatusTimer);
	micTransient = text ? { state, text, hud: hud == null ? text : hud } : null;
	renderMicStatus();
	if (text) updateStatus(text, state === 'error' || state === 'blocked' ? 'error' : '');
	if (micTransient && autoHideMs) {
		const mine = micTransient;
		micStatusTimer = setTimeout(() => { if (micTransient === mine) { micTransient = null; renderMicStatus(); } }, autoHideMs);
	}
}

function clearMicTransient() {
	clearTimeout(micStatusTimer);
	micTransient = null;
	renderMicStatus();
}

function sttTotalMb() {
	let t = 0;
	for (const f of Object.values(sttFiles)) t += f.total || 0;
	return t ? Math.round(t / 1048576) : 0;
}

function onSttProgress(p) {
	if (!p || !p.file) return;
	if (p.status === 'progress' && p.total) sttFiles[p.file] = { loaded: p.loaded || 0, total: p.total };
	else if (p.status === 'done' && sttFiles[p.file]) sttFiles[p.file].loaded = sttFiles[p.file].total;
	let l = 0, t = 0;
	for (const f of Object.values(sttFiles)) { l += f.loaded; t += f.total; }
	const pct = t ? Math.min(99, Math.floor((l / t) * 100)) : 0;
	if (pct !== sttPct) { sttPct = pct; if (!micTransient) renderMicStatus(); }
}

// ---- Whisper (worker first, main thread fallback) ---------------------------
const STT_WORKER_SRC = `
let asr = null;
self.onmessage = async (e) => {
	const m = e.data;
	try {
		if (m.type === 'load') {
			const { pipeline, env } = await import(m.cdn);
			env.allowLocalModels = false;
			asr = await pipeline('automatic-speech-recognition', m.model, {
				progress_callback: (p) => { try { self.postMessage({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } }); } catch (err) {} }
			});
			self.postMessage({ type: 'ready' });
		} else if (m.type === 'run') {
			const out = await asr(m.audio);
			self.postMessage({ type: 'result', id: m.id, text: out && out.text ? out.text : '' });
		}
	} catch (err) {
		self.postMessage({ type: 'error', id: m.id, name: err && err.name, message: String((err && err.message) || err) });
	}
};`;

const STT_WORKER_STALL_MS = 45000;

function loadSttInWorker() {
	return new Promise((resolve, reject) => {
		let w;
		try {
			const url = URL.createObjectURL(new Blob([STT_WORKER_SRC], { type: 'text/javascript' }));
			w = new Worker(url, { type: 'module' });
			URL.revokeObjectURL(url);
		} catch (e) { reject(e); return; }
		const pending = new Map();
		let nextId = 1;
		let ready = false;
		// Watchdog: if the worker goes quiet while loading (no progress or ready
		// for STT_WORKER_STALL_MS), give up on it and fall back to the main thread
		// rather than sitting at "Loading… 99%" forever.
		let stall = 0;
		const armStall = () => {
			clearTimeout(stall);
			if (!ready) stall = setTimeout(() => fail(new Error('speech worker stalled while loading')), STT_WORKER_STALL_MS);
		};
		const fail = (err) => {
			clearTimeout(stall);
			for (const p of pending.values()) p.reject(err);
			pending.clear();
			if (!ready) reject(err);
		};
		w.onerror = (ev) => { ev.preventDefault?.(); fail(new Error(ev.message || 'speech worker failed')); };
		w.onmessage = (ev) => {
			const m = ev.data || {};
			if (m.type === 'progress') { onSttProgress(m.p); armStall(); }
			else if (m.type === 'ready') {
				ready = true;
				clearTimeout(stall);
				resolve((audio) => new Promise((res, rej) => {
					const id = nextId++;
					pending.set(id, { resolve: res, reject: rej });
					w.postMessage({ type: 'run', id, audio }, [audio.buffer]);
				}));
			} else if (m.type === 'result') {
				const p = pending.get(m.id); pending.delete(m.id); if (p) p.resolve(m.text);
			} else if (m.type === 'error') {
				const err = Object.assign(new Error(m.message), { sttName: m.name });
				if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.reject(err); }
				else fail(err);
			}
		};
		sttWorker = w;
		armStall();
		w.postMessage({ type: 'load', cdn: STT_CDN, model: STT_MODEL });
	});
}

async function loadSttOnMainThread() {
	const { pipeline, env } = await import(/* @vite-ignore */ STT_CDN);
	env.allowLocalModels = false; // fetch from the HF hub, not a local path
	const asr = await pipeline('automatic-speech-recognition', STT_MODEL, { progress_callback: onSttProgress });
	return async (audio) => {
		const out = await asr(audio);
		return out && out.text ? out.text : '';
	};
}

// Lazily download + build the Whisper pipeline (cached in the browser after the
// first run). Returned promise is memoized; on failure it resets so we can retry.
function loadSttPipeline() {
	if (!sttPipelinePromise) {
		sttFiles = {};
		sttPct = 0;
		renderMicStatus();
		const viaWorker = sttWorkerBroken ? Promise.reject(new Error('worker disabled')) : loadSttInWorker();
		sttPipelinePromise = viaWorker
			.catch((e) => {
				if (!sttWorkerBroken) console.warn('Speech worker unavailable, transcribing on the main thread:', e && e.message);
				sttWorkerBroken = true;
				if (sttWorker) { try { sttWorker.terminate(); } catch (err) { /* ignore */ } sttWorker = null; }
				sttFiles = {};
				return loadSttOnMainThread();
			})
			.then((run) => {
				sttRun = run;
				sttModelReady = true;
				sttPct = 100;
				renderMicStatus();
				return run;
			})
			.catch((e) => {
				sttPipelinePromise = null; // allow a later retry
				e.sttModelLoad = true;
				throw e;
			});
	}
	return sttPipelinePromise;
}

// ---- microphone -----------------------------------------------------------
async function micPermissionState() {
	try {
		if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
		const r = await navigator.permissions.query({ name: 'microphone' });
		return r.state; // 'granted' | 'denied' | 'prompt'
	} catch (e) {
		return 'unknown';
	}
}

function micStreamLive() {
	return !!(micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live'));
}

async function ensureMicStream() {
	clearTimeout(micReleaseTimer);
	if (micStreamLive()) return micStream;
	micStream = null;
	// A permission ask nobody answers (or that a headset never shows) would
	// otherwise look like a dead button: say where to look after a few seconds.
	const hint = setTimeout(() => {
		if (micMode === 'off' || micListening) return;
		setMicStatus('starting', micInXr() || IS_QUEST_BROWSER
			? 'Waiting for microphone permission. No prompt? Exit VR, press 🎤 once and allow it, then come back.'
			: 'Waiting for microphone permission — allow it in the browser prompt.', { hud: 'Allow mic…' });
	}, MIC_PROMPT_HINT_MS);
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		micStream = stream;
	} finally {
		clearTimeout(hint);
	}
	try { localStorage.setItem(MIC_USED_KEY, '1'); } catch (e) { /* ignore */ }
	for (const t of micStream.getAudioTracks()) {
		t.addEventListener('ended', () => {
			if (micMode === 'off') return;
			stopMicCapture();
			setMicStatus('error', 'Microphone disconnected. Plug it back in and press 🎤 again.', { hud: 'Mic disconnected', autoHideMs: 15000 });
		});
	}
	return micStream;
}

function releaseMicStream() {
	clearTimeout(micReleaseTimer);
	if (micStream) { for (const t of micStream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } } }
	micStream = null;
}

function scheduleMicRelease(ms) {
	clearTimeout(micReleaseTimer);
	micReleaseTimer = setTimeout(() => { if (micMode === 'off') releaseMicStream(); }, ms);
}

// Decode an encoded audio blob (webm/ogg/mp4) to a mono 16 kHz Float32Array,
// which is what Whisper expects.
async function decodeTo16kMono(blob) {
	const AC = window.AudioContext || window.webkitAudioContext;
	const buf = await blob.arrayBuffer();
	const tmp = new AC();
	let decoded;
	try {
		decoded = await tmp.decodeAudioData(buf);
	} finally {
		tmp.close();
	}
	const rate = 16000;
	const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
	const src = offline.createBufferSource();
	src.buffer = decoded;
	src.connect(offline.destination);
	src.start(0);
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0);
}

// Whisper marks non-speech with bracketed tags ([Music], [BLANK_AUDIO], (beep),
// *coughs*, ♪). Strip them; if no words are left there is nothing to send.
function cleanTranscript(text) {
	const t = String(text || '')
		.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|<[^>]*>|[♪♫♩♬]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

async function transcribeBlob(blob) {
	if (!blob || blob.size < 1200) return ''; // effectively empty
	const run = await loadSttPipeline();
	const audio = await decodeTo16kMono(blob);
	if (!audio || audio.length < 1600) return ''; // < ~0.1s
	// Copy: the worker takes ownership of the buffer it is sent.
	return (await run(new Float32Array(audio))).trim();
}

// One MediaRecorder per utterance; each keeps its own chunks so a new one can
// start before the old one has flushed (no gap between segments).
function startUtterance() {
	const rec = new MediaRecorder(micStream);
	const chunks = [];
	rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
	rec._gsChunks = chunks;
	rec.start();
	mediaRecorder = rec;
	vadSegStart = performance.now();
	return rec;
}

function stopRecorder(rec) {
	return new Promise((resolve) => {
		if (!rec || rec.state === 'inactive') { resolve(null); return; }
		rec.onstop = () => {
			const c = rec._gsChunks || [];
			resolve(c.length ? new Blob(c, { type: c[0].type || 'audio/webm' }) : null);
		};
		try { rec.stop(); } catch (e) { resolve(null); }
	});
}

function stopUtterance() {
	const rec = mediaRecorder;
	mediaRecorder = null;
	return stopRecorder(rec);
}

// Transcriptions run one at a time, in order.
function transcribeAndDeliver(blob, autoSend) {
	if (!blob) return Promise.resolve();
	sttWaiting++;
	const job = sttQueue.then(() => deliverOne(blob, autoSend)).finally(() => { sttWaiting--; renderMicStatus(); });
	sttQueue = job.catch(() => {});
	return job;
}

async function deliverOne(blob, autoSend) {
	sttBusy = true;
	if (sttModelReady) setMicStatus('transcribing', 'Transcribing…');
	else renderMicStatus(); // model still loading: show its progress
	try {
		const raw = await transcribeBlob(blob);
		const text = cleanTranscript(raw);
		if (!text) {
			micStats.dropped++;
			setMicStatus('info', raw ? 'Heard only noise — nothing sent' : 'No speech heard — nothing sent', { hud: 'Nothing heard', autoHideMs: 2500 });
			return;
		}
		setInputText(text);
		if (autoSend && !isLoading) {
			sendActiveChatField();
			setMicStatus('sent', `Sent: “${text.length > 60 ? text.slice(0, 57) + '…' : text}”`, { hud: 'Sent', autoHideMs: 2500 });
		} else {
			setMicStatus('info', 'Transcribed into the message box — press Send when the reply is done', { hud: 'Transcribed', autoHideMs: 6000 });
		}
	} catch (e) {
		micError(e);
	} finally {
		sttBusy = false;
	}
}

function micError(e) {
	console.error('Speech error:', e);
	const name = (e && (e.name || e.sttName)) || '';
	const msg = e && e.message ? e.message : '';
	const quest = micInXr() || IS_QUEST_BROWSER;
	if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
		setMicStatus('blocked', quest
			? 'Microphone blocked. On Quest: Settings › Apps › Browser › Microphone on, and allow it for this site in Browser › Settings › Site permissions. Then press 🎤 again.'
			: 'Microphone blocked. Allow it for this site (the icon left of the address bar › Microphone), then press 🎤 again.',
		{ hud: 'Mic blocked — see menu' });
	} else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
		setMicStatus('nomic', 'No microphone found. Connect one (or check your system sound input), then press 🎤 again.', { hud: 'No mic found' });
	} else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
		setMicStatus('error', 'The microphone is busy or failed to start (another app may be using it).', { hud: 'Mic busy' });
	} else if (e && e.sttModelLoad) {
		setMicStatus('error', 'Couldn’t load the speech model (needs internet the first time): ' + (msg || name || 'unknown error'), { hud: 'Speech model failed' });
	} else {
		setMicStatus('error', 'Speech error: ' + (msg || name || 'unknown'), { hud: 'Speech error' });
	}
	updateMicButtonDOM();
}

// --- Voice-activity detection (always-on mode) ---
// IMPORTANT: this is pumped from the main XR animation loop (pumpVad), NOT from
// window.requestAnimationFrame — the latter does not fire during an immersive
// WebXR session, which is why always-on transcription was dead in MR.
function startVad() {
	const AC = window.AudioContext || window.webkitAudioContext;
	vadContext = new AC();
	const source = vadContext.createMediaStreamSource(micStream);
	vadAnalyser = vadContext.createAnalyser();
	vadAnalyser.fftSize = 1024;
	source.connect(vadAnalyser);
	vadData = new Float32Array(vadAnalyser.fftSize);
	vadSpeaking = false;
	vadSilenceMs = 0;
	vadSpeechMs = 0;
	vadNoise = null;
	vadLastTime = performance.now();
}

function vadThreshold() {
	return Math.max(VAD_MIN_THRESHOLD, (vadNoise || 0) * VAD_FLOOR_FACTOR + VAD_FLOOR_MARGIN);
}

// One VAD step. Called every frame from renderer.setAnimationLoop so it runs in
// both the windowed view and immersive MR.
function pumpVad() {
	if (micMode !== 'always' || !micListening || !vadAnalyser) return;
	vadAnalyser.getFloatTimeDomainData(vadData);
	let sum = 0;
	for (let i = 0; i < vadData.length; i++) sum += vadData[i] * vadData[i];
	const rms = Math.sqrt(sum / vadData.length);
	const now = performance.now();
	const dt = Math.min(100, now - vadLastTime);
	vadLastTime = now;
	if (vadNoise == null) vadNoise = rms;
	const thr = vadThreshold();
	if (rms > (vadSpeaking ? thr * VAD_HOLD_RATIO : thr)) {
		vadSpeaking = true;
		vadSpeechMs += dt;
		vadSilenceMs = 0;
	} else if (vadSpeaking) {
		vadSilenceMs += dt;
	} else {
		// Noise floor: falls fast, rises slowly (a steady fan becomes "silence").
		const k = rms < vadNoise ? Math.min(1, dt / 300) : Math.min(1, dt / 3000);
		vadNoise += (rms - vadNoise) * k;
	}
	if (sttBusy) return;
	const age = now - vadSegStart;
	if (vadSpeaking && vadSilenceMs >= VAD_SILENCE_MS) {
		if (vadSpeechMs >= VAD_MIN_SPEECH_MS) segmentUtterance(); else rotateIdleUtterance();
	} else if (vadSpeaking && age >= VAD_MAX_SEGMENT_MS) {
		segmentUtterance();
	} else if (!vadSpeaking && age >= VAD_IDLE_ROTATE_MS) {
		rotateIdleUtterance();
	}
}

function resetVadSegment() {
	vadSpeaking = false;
	vadSilenceMs = 0;
	vadSpeechMs = 0;
}

function stopVad() {
	if (vadContext) { try { vadContext.close(); } catch (e) { /* ignore */ } vadContext = null; }
	vadAnalyser = null;
	vadData = null;
	resetVadSegment();
}

// End the current utterance, immediately begin capturing the next, and transcribe
// the finished one in the background.
async function segmentUtterance() {
	micStats.segments++;
	micStats.lastSegmentMs = Math.round(performance.now() - vadSegStart);
	resetVadSegment();
	const old = mediaRecorder;
	if (micMode === 'always' && micStreamLive()) startUtterance(); else mediaRecorder = null;
	const blob = await stopRecorder(old);
	await transcribeAndDeliver(blob, true);
}

// Nothing (or only a blip) was said: start a fresh recording and drop the old one.
function rotateIdleUtterance() {
	micStats.rotations++;
	resetVadSegment();
	const old = mediaRecorder;
	if (micMode === 'always' && micStreamLive()) startUtterance(); else mediaRecorder = null;
	stopRecorder(old);
}

// Always-on listening toggle (MIC button + DOM button).
async function toggleMicAlwaysOn() {
	if (!speechSupported) {
		setMicStatus('error', 'Microphone capture isn’t available here (needs HTTPS and a browser with microphone access).', { hud: 'No mic support' });
		return;
	}
	if (micMode === 'always') { stopAlwaysOn(); return; }
	if (micMode === 'ptt') return; // let a push-to-talk finish first
	micMode = 'always';
	micListening = false;
	clearMicTransient();
	updateMicButtonDOM();
	try {
		await ensureMicStream();
		if (micMode !== 'always') return; // toggled off during setup
		clearMicTransient();
		await loadSttPipeline();          // listening starts only once Whisper is ready
		if (micMode !== 'always') return;
		startVad();
		startUtterance();
		micListening = true;
		clearMicTransient();
		updateMicButtonDOM();
	} catch (e) {
		stopMicCapture();
		micError(e);
	}
}

// Stop recording (any mode) without transcribing; release the microphone.
function stopMicCapture() {
	micMode = 'off';
	micListening = false;
	pttHand = null;
	stopVad();
	const rec = mediaRecorder;
	mediaRecorder = null;
	if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* ignore */ } }
	releaseMicStream();
	updateMicButtonDOM();
}

function stopAlwaysOn() {
	stopMicCapture();
	setMicStatus('off', 'Mic off', { autoHideMs: 2000 });
}

// Push-to-talk (controller A/X button). Only engages when always-on is off.
// It starts from gamepad polling (no user activation), so a permission that
// was never granted can't be asked for reliably here: say so instead.
async function startPTT(hand) {
	if (!speechSupported) {
		setMicStatus('error', 'Microphone capture isn’t available here (needs HTTPS and a browser with microphone access).', { hud: 'No mic support' });
		return;
	}
	if (micMode !== 'off') return; // busy: already listening (always-on or PTT)
	micMode = 'ptt';
	pttHand = hand;
	micListening = false;
	clearMicTransient();
	updateMicButtonDOM();
	const perm = await micPermissionState();
	if (micMode !== 'ptt' || pttHand !== hand) return; // released already
	if (perm === 'denied') {
		stopMicCapture();
		micError({ name: 'NotAllowedError', message: 'Permission denied' });
		return;
	}
	if (perm === 'prompt' && !micStreamLive()) {
		setMicStatus('starting', 'Push-to-talk needs microphone permission: allow it if asked, or press 🎤 in the menu once.', { hud: 'Allow mic…' });
	}
	try {
		await ensureMicStream();
		if (micMode !== 'ptt' || pttHand !== hand) { if (micMode === 'off') scheduleMicRelease(MIC_RELEASE_MS); return; }
		startUtterance();          // capture immediately…
		micListening = true;
		clearMicTransient();
		updateMicButtonDOM();
		loadSttPipeline().catch(() => {}); // …while the model warms in the background
	} catch (e) {
		stopMicCapture();
		micError(e);
	}
}

async function stopPTT(hand) {
	if (micMode !== 'ptt' || hand !== pttHand) return;
	const wasListening = micListening;
	micMode = 'off';
	micListening = false;
	pttHand = null;
	updateMicButtonDOM();
	const blob = await stopUtterance();
	scheduleMicRelease(MIC_RELEASE_MS);
	if (!wasListening) { renderMicStatus(); return; }
	await transcribeAndDeliver(blob, true);
}

// Enter VR (a real click): if this person has used the mic before and the
// browser would still ask, ask now — a prompt is far more reliable outside the
// immersive session than in it. Also warm the model. Never-mic users: nothing.
function onEnterVrClickForMic() {
	if (!speechSupported || micInXr()) return;
	let used = false;
	try { used = localStorage.getItem(MIC_USED_KEY) === '1'; } catch (e) { /* ignore */ }
	if (!used) return;
	micPermissionState().then((state) => {
		if (state === 'prompt' && !micStreamLive()) {
			navigator.mediaDevices.getUserMedia({ audio: true })
				.then((s) => { for (const t of s.getTracks()) t.stop(); })
				.catch(() => { /* answered "no": the mic button will explain */ });
		}
		if (state !== 'denied') loadSttPipeline().catch(() => {});
	});
}

function updateMicButtonDOM() {
	const on = micMode !== 'off';
	const listening = on && micListening;
	for (const btn of [document.getElementById('mic-button'), desktopMicButton]) {
		if (!btn) continue;
		btn.classList.toggle('listening', listening);
		btn.classList.toggle('mic-pending', on && !listening);
		btn.setAttribute('aria-pressed', String(on));
	}
	renderMicStatus();
}

function hslToHex(h, s, l) {
	const c = new THREE.Color();
	c.setHSL(h / 360, s, l);
	return '#' + c.getHexString();
}

// Black or white label text on the Background Color bar, by relative luminance
// (WCAG-style sRGB). A text-shadow in CSS covers the in-between greys.
function contrastTextOn(hex) {
	const c = new THREE.Color(hex);
	const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
	const L = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
	return L > 0.55 ? '#111111' : '#ffffff';
}

function syncBgColorPreview(hex) {
	if (dchatColorPicker) dchatColorPicker.value = hex;
	if (dchatColorPreview) {
		dchatColorPreview.style.background = hex;
		dchatColorPreview.style.color = contrastTextOn(hex);
	}
}

// Environment tab: AR/VR toggle (+ Exit VR while in a headset or phone XR)
// and the background colour controls. Safe to call before the DOM exists.
function renderDomEnv() {
	if (!dchatEnvModeMount) return;
	const inXr = !!(renderer && renderer.xr && renderer.xr.isPresenting) ||
		(typeof mobileXRMode !== 'undefined' && !!mobileXRMode);
	// In an AR session the buttons show what you see now (passthrough or
	// skybox); otherwise which mode Enter will start.
	const inArSession = !!(renderer && renderer.xr && renderer.xr.isPresenting) && xrSessionMode === 'immersive-ar';
	const activeMode = inArSession ? (isVRMode ? 'vr' : 'ar') : effectiveXrMode();
	const buttons = [
		...ENV_MODE_BUTTONS.map(b => (xrModeSupport[b.id] === false && 'xr' in navigator && !(b.id === 'vr' && !xrModeSupport.ar)
			? { ...b, label: b.id === 'ar' ? 'AR (not supported)' : 'VR (not supported)', variant: 'disabled' }
			: { ...b, variant: b.id === activeMode ? 'active' : 'inactiveToggle' })),
		...(inXr ? EXIT_XR_BUTTON : [])
	];
	mountButtonsToDOM(dchatEnvModeMount, buttons, { width: 256, height: 40, gap: 6, fontSize: 13, perRow: 2 }, handleMenuAction);
	const colorEnabled = envColorControlsEnabled();
	if (dchatEnvControls) dchatEnvControls.classList.toggle('disabled', !colorEnabled);
	const note = dchatEnvControls && dchatEnvControls.querySelector('.dchat-disabled-note');
	if (note) {
		note.style.display = colorEnabled ? 'none' : '';
		note.textContent = colorEnabled
			? ''
			: 'Background color is unavailable while a VR session is active.';
	}
	syncBgColorPreview(hslToHex(vrBgHue, vrBgSat, vrBgLight));
}

/**
 * Background colour controls work on desktop and phone via the "Select Color"
 * bar (a native <input type=color>). The same menu is painted in the headset
 * (htmlInCanvas.js / vrWindows.js); a ray click on the bar is forwarded to the
 * color input. The OS colour dialog itself cannot appear inside a WebXR
 * session. Phone cardboard/AR has no menu on screen.
 */
function envColorControlsEnabled() {
	if (typeof mobileXRMode !== 'undefined' && mobileXRMode) return false;
	return true;
}

function applyEnvironmentMode() {
	const color = new THREE.Color();
	color.setHSL(vrBgHue / 360, vrBgSat, vrBgLight);

	const inMobileXR = typeof mobileXRMode !== 'undefined' && !!mobileXRMode;
	const inWebXR = !!(renderer && renderer.xr && renderer.xr.isPresenting);

	// AR passthrough: nothing may cover the room (see enforceArPassthrough).
	if (arPassthroughActive()) {
		if (vrSkybox) vrSkybox.visible = false;
		scene.background = null;
		renderer.setClearColor(0x000000, 0.0);
		enforceArPassthrough(true);
		return;
	}
	restoreArHidden();

	// Active equirect HDRI as background wins over solid color / skybox.
	if (hdriEquirect && hdriUseAsBackground) {
		scene.background = hdriEquirect;
		if (vrSkybox) vrSkybox.visible = false;
		if (!inWebXR && !inMobileXR) renderer.setClearColor(0x000000, 1);
		else renderer.setClearColor(0x000000, 0.0);
		return;
	}

	// Desktop / mobile browser (not in an XR session): solid scene background
	// so Environment tab color changes are visible immediately.
	if (!inWebXR && !inMobileXR) {
		scene.background = color.clone();
		if (vrSkybox) vrSkybox.visible = false;
		renderer.setClearColor(color, 1);
		return;
	}

	// Immersive VR / Cardboard: colored skybox.
	if (vrSkybox) {
		vrSkybox.material.color.copy(color);
		vrSkybox.visible = true;
	}
	scene.background = null;
	renderer.setClearColor(0x000000, 0.0);
}

/**
 * "Use as background" means the HDRI is the background. Scene code often sets
 * its own (`scene.background = new THREE.Color(...)`), and it runs after (or,
 * when the HDRI is still downloading, before) the HDRI is applied, so the box
 * stayed checked while a solid colour showed until it was toggled off and on.
 * Called every frame before rendering: puts the HDRI back if anything replaced
 * it. With the box off, scene code / the background colour keep control.
 */
function keepHdriBackground() {
	if (arPassthroughActive()) { enforceArPassthrough(false); return; }
	if (hdriEquirect && hdriUseAsBackground && scene.background !== hdriEquirect) applyEnvironmentMode();
}

// AR passthrough is on: an immersive-ar session showing the room (not the
// VR colour skybox, which the Environment tab's "VR (color)" switches back to).
function arPassthroughActive() {
	return !!(renderer && renderer.xr && renderer.xr.isPresenting) && xrSessionMode === 'immersive-ar' && !isVRMode;
}
// Scene code can set scene.background or build a sky / HDRI dome at any time;
// in AR passthrough both would hide the room. Every frame the background is
// stashed and cleared; about twice a second (and right away when AR starts)
// dome meshes (sceneFit.js isDomeObject) are hidden. Both come back when AR
// ends or VR (color) is picked.
const _arHidden = new Set();
let _arStashedBackground;
let _arDomeScanAt = 0;
function enforceArPassthrough(scanNow) {
	if (scene.background) { _arStashedBackground = scene.background; scene.background = null; }
	const now = performance.now();
	if (!scanNow && now - _arDomeScanAt < 500) return;
	_arDomeScanAt = now;
	scene.traverse((o) => {
		if (o === vrSkybox || !o.visible || !o.isMesh) return;
		if (isDomeObject(o)) { _arHidden.add(o); o.visible = false; }
	});
}
function restoreArHidden() {
	for (const o of _arHidden) o.visible = true;
	_arHidden.clear();
	if (_arStashedBackground !== undefined) {
		if (scene.background == null) scene.background = _arStashedBackground;
		_arStashedBackground = undefined;
	}
}

// ============================================================================
// Scene Manager
// ============================================================================
const fileInput = document.getElementById('scene-file-input');
const exportModal = document.getElementById('export-modal');
const exportNameInput = document.getElementById('export-name');
const exportExtInput = document.getElementById('export-ext');
const exportPreview = document.getElementById('export-preview');
const exportScreenshotBtn = document.getElementById('export-screenshot-btn');
const exportCancelBtn = document.getElementById('export-cancel-btn');
const exportConfirmBtn = document.getElementById('export-confirm-btn');
const exportDownloadBtn = document.getElementById('export-download-btn');

let pendingExportThumbnail = null;

// GLB / FBX export (exporter.js). Roots = everything clearUserObjects would
// remove: user content under the scene root and the Walk-in-AR placement group.
const sceneModelExport = initSceneExport({
	// World transforms are exported, so a rotated origin is baked in (the file
	// matches what is on screen).
	getRoots: () => userContentRoots(),
	getSceneName: () => activeScene?.name || 'GS scene',
	notify: (text, kind) => updateStatus(text, kind),
	isImmersive: () => renderer.xr.isPresenting,
	canExport: () => sceneExportsAllowed(),
	onBlocked: () => showExportsBlocked()
});
window.gsSceneExport = sceneModelExport;
sceneModelExport.mountShareTab(document.getElementById('dchat-share'), {
	onShareLink: () => shareCurrentScene(),
	onEmbed: () => embedCurrentScene(),
	allowExport: { get: () => uploadAllowExport, set: (v) => setUploadAllowExport(v) }
});
const embedUi = initEmbedUi({
	copyText: (text) => copyText(text),
	notify: (text, kind) => updateStatus(text, kind),
	isImmersive: () => renderer.xr.isPresenting,
	alert: (message, opts) => gsAlert(message, opts)
});
window.gsEmbed = embedUi;

// --- Export permission (see sceneExportPolicy.js) ---
// A Community scene whose creator chose "Don't allow exports" is loaded with
// exportLocked (communitySceneFields) for everyone but its creator. The flag
// stays on the active scene through chat edits, so editing it doesn't unlock
// it. The creator is whoever holds the owner key the server returned at
// upload (kept in this browser's localStorage; GS has no accounts).
const OWNED_SCENES_KEY = 'gs.ownedScenes';
function ownedSceneKeys() {
	try { return JSON.parse(localStorage.getItem(OWNED_SCENES_KEY) || '{}') || {}; } catch { return {}; }
}
function ownerKeyFor(id) { return id ? ownedSceneKeys()[id] || null : null; }
function rememberOwnerKey(id, key) {
	if (!id || !key) return;
	const all = ownedSceneKeys();
	all[id] = key;
	try { localStorage.setItem(OWNED_SCENES_KEY, JSON.stringify(all)); } catch { /* storage blocked */ }
}
function ownerHeaders(id, extra = {}) {
	const key = ownerKeyFor(id);
	return key ? { ...extra, [OWNER_KEY_HEADER]: key } : extra;
}
function sceneExportsAllowed() { return !activeScene?.exportLocked; }
function showExportsBlocked() {
	updateStatus('Exports are off for this scene', 'error');
	gsAlert(EXPORTS_OFF_MESSAGE, { title: 'Exports turned off' });
}
function setUploadAllowExport(v) {
	uploadAllowExport = v !== false;
	const box = document.getElementById('dchat-upload-allow-export');
	if (box) box.checked = uploadAllowExport;
	sceneModelExport.refreshShareTab();
}
function refreshExportPermissionUi() {
	sceneModelExport.refreshShareTab();
	document.body.classList.toggle('gs-exports-locked', !sceneExportsAllowed());
}

function snapshotSystemObjects() {
	systemObjectIds.clear();
	scene.traverse(obj => systemObjectIds.add(obj.uuid));
	for (const helper of arGizmoHelpers) {
		helper.traverse(obj => systemObjectIds.add(obj.uuid));
	}
	systemOverlayIds.clear();
	const overlay = document.getElementById('overlay-root');
	for (const child of overlay.children) {
		if (child.id) systemOverlayIds.add(child.id);
	}
}

function captureScreenshot() {
	const size = 256;
	const rt = new THREE.WebGLRenderTarget(size, size);
	renderer.setRenderTarget(rt);
	keepHdriBackground();
	renderer.render(scene, camera);
	renderer.setRenderTarget(null);

	const pixels = new Uint8Array(size * size * 4);
	renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);

	const cvs = document.createElement('canvas');
	cvs.width = size;
	cvs.height = size;
	const c = cvs.getContext('2d');
	const imgData = c.createImageData(size, size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const src = ((size - 1 - y) * size + x) * 4;
			const dst = (y * size + x) * 4;
			imgData.data[dst] = pixels[src];
			imgData.data[dst + 1] = pixels[src + 1];
			imgData.data[dst + 2] = pixels[src + 2];
			imgData.data[dst + 3] = 255;
		}
	}
	c.putImageData(imgData, 0, 0);
	rt.dispose();
	return cvs.toDataURL('image/jpeg', 0.7);
}

function pixelsToCanvas(pixels, w, h) {
	const cvs = document.createElement('canvas');
	cvs.width = w;
	cvs.height = h;
	const c = cvs.getContext('2d');
	const imgData = c.createImageData(w, h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const src = ((h - 1 - y) * w + x) * 4;
			const dst = (y * w + x) * 4;
			imgData.data[dst] = pixels[src];
			imgData.data[dst + 1] = pixels[src + 1];
			imgData.data[dst + 2] = pixels[src + 2];
			imgData.data[dst + 3] = 255;
		}
	}
	c.putImageData(imgData, 0, 0);
	return cvs;
}

function encodeCommunityThumb(cvs) {
	const dataBytes = (url) => {
		const i = url.indexOf(',');
		if (i < 0) return Infinity;
		const b64 = url.slice(i + 1);
		return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
	};
	const tryEncode = (src, type, q) => {
		const url = src.toDataURL(type, q);
		if (!url.startsWith(`data:${type}`)) return null;
		return { url, bytes: dataBytes(url) };
	};
	for (const type of ['image/webp', 'image/jpeg']) {
		for (const q of [0.82, 0.68, 0.52, 0.4, 0.3]) {
			const r = tryEncode(cvs, type, q);
			if (r && r.bytes <= THUMB_MAX_BYTES) return r.url;
		}
	}
	// Last resort: shrink and JPEG.
	const small = document.createElement('canvas');
	small.width = 320;
	small.height = 180;
	small.getContext('2d').drawImage(cvs, 0, 0, 320, 180);
	for (const q of [0.55, 0.4, 0.28]) {
		const r = tryEncode(small, 'image/jpeg', q);
		if (r && r.bytes <= THUMB_MAX_BYTES) return r.url;
	}
	const last = small.toDataURL('image/jpeg', 0.22);
	return last.startsWith('data:image/') ? last : '';
}

function hideSystemObjectsForThumb() {
	const hidden = [];
	const hide = (obj) => {
		if (!obj) return;
		obj.traverse((o) => {
			if (o.visible) { o.visible = false; hidden.push(o); }
		});
	};
	for (const root of menuPriorityRoots) hide(root);
	if (vrWindows) {
		for (const w of vrWindows.windows) hide(w.mesh);
	}
	if (renderer && renderer.xr) {
		for (let i = 0; i < 2; i++) {
			hide(renderer.xr.getController?.(i));
			hide(renderer.xr.getControllerGrip?.(i));
			hide(renderer.xr.getHand?.(i));
			// Controller rays are children of the controller; reticles are
			// already in menuPriorityRoots.
		}
	}
	scene.traverse((o) => {
		if (!o.visible) return;
		if (o.userData && (o.userData.gsNoExport || o.userData.vrWindow)) {
			o.visible = false;
			hidden.push(o);
		}
	});
	return hidden;
}

/** Offscreen screenshot from the scene's spawn/start camera pose (not the
 *  user's current view). System UI (menus, controllers, gsNoExport) is hidden.
 *  Pass { initial: false } to use the current camera (tests). */
function captureCommunityThumbnail({ initial = true } = {}) {
	if (!renderer || !scene || !camera) return '';
	const w = THUMB_WIDTH;
	const h = THUMB_HEIGHT;
	const saved = {
		pos: camera.position.clone(),
		quat: camera.quaternion.clone(),
		up: camera.up.clone(),
		aspect: camera.aspect,
		near: camera.near,
		far: camera.far,
		fov: camera.fov
	};
	const hidden = hideSystemObjectsForThumb();
	const prevTarget = renderer.getRenderTarget();
	const prevXr = renderer.xr ? renderer.xr.enabled : false;
	let rt = null;
	try {
		if (initial) {
			camera.position.copy(DEFAULT_CAMERA_POSITION);
			camera.up.set(0, 1, 0);
			camera.quaternion.identity();
			camera.lookAt(ORBIT_TARGET);
		}
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		if (renderer.xr) renderer.xr.enabled = false;
		rt = new THREE.WebGLRenderTarget(w, h);
		if ('colorSpace' in rt.texture && renderer.outputColorSpace) {
			rt.texture.colorSpace = renderer.outputColorSpace;
		}
		renderer.setRenderTarget(rt);
		keepHdriBackground();
		renderer.render(scene, camera);
		const pixels = new Uint8Array(w * h * 4);
		renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
		const cvs = pixelsToCanvas(pixels, w, h);
		return encodeCommunityThumb(cvs);
	} catch (err) {
		console.warn('Community thumbnail capture failed:', err);
		return '';
	} finally {
		renderer.setRenderTarget(prevTarget);
		if (renderer.xr) renderer.xr.enabled = prevXr;
		if (rt) rt.dispose();
		camera.position.copy(saved.pos);
		camera.quaternion.copy(saved.quat);
		camera.up.copy(saved.up);
		camera.aspect = saved.aspect;
		camera.near = saved.near;
		camera.far = saved.far;
		camera.fov = saved.fov;
		camera.updateProjectionMatrix();
		for (const o of hidden) o.visible = true;
	}
}
window.__gsCaptureCommunityThumbnail = (opts) => captureCommunityThumbnail(opts);
window.__gsPaintElementToCanvas = paintElementToCanvas;

function disposeRecursive(obj) {
	if (obj.geometry) obj.geometry.dispose();
	if (obj.material) {
		if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
		else obj.material.dispose();
	}
	for (const child of [...obj.children]) {
		disposeRecursive(child);
	}
}


// ============================================================================
// Code tab — view/edit generated VR program (active scene + session blocks)
// ============================================================================
function setCodeEditorStatus(text, kind) {
	if (!dchatCodeStatus) return;
	dchatCodeStatus.textContent = text || '';
	dchatCodeStatus.className = kind || '';
}

function buildCodeEditorSource() {
	const chunks = [];
	const sc = activeScene;
	if (sc) {
		const name = String(sc.name || 'Scene').replace(/\n/g, ' ');
		(sc.codeBlocks || []).forEach((code, i) => {
			chunks.push(`// --- scene[${sc.id}] #${i} ${name} ---\n${String(code).trim()}`);
		});
	}
	executedCodeBlocks.forEach((code, i) => {
		chunks.push(`// --- block ${i} ---\n${String(code).trim()}`);
	});
	return chunks.join('\n\n');
}

/** Editor text -> { sceneBlocks, sessionBlocks }. sceneBlocks is null when the
 *  text has no `scene[<active id>]` markers (the scene's code is left as is). */
function parseCodeEditorSource(text) {
	let sceneBlocks = null;
	const sessionBlocks = [];
	const trimmed = (text || '').trim();
	if (!trimmed) return { sceneBlocks, sessionBlocks };

	const parts = trimmed.split(/(?=^\/\/ --- .+? ---$)/m);
	for (const part of parts) {
		const m = part.match(/^\/\/ --- (.+?) ---\r?\n?([\s\S]*)$/);
		if (!m) {
			const orphan = part.trim();
			if (orphan) sessionBlocks.push(orphan);
			continue;
		}
		const label = m[1].trim();
		const code = (m[2] || '').trim();
		if (!code) continue;
		const sceneMatch = label.match(/^scene\[([^\]]+)\]/);
		if (sceneMatch) {
			if (activeScene && sceneMatch[1] === activeScene.id) (sceneBlocks ||= []).push(code);
		} else {
			sessionBlocks.push(code);
		}
	}
	return { sceneBlocks, sessionBlocks };
}

function sceneBlockKey(sc, i) { return `scene:${sc.id}#${i}`; }
function sessionBlockKey(i) { return `block:${i}`; }

/** Editor text -> ordered [{key, code, sceneId}] using the // --- markers. */
function parseCodeEditorBlocks(text) {
	const { sceneBlocks, sessionBlocks } = parseCodeEditorSource(text);
	const blocks = [];
	const sc = activeScene;
	if (sc) {
		(sceneBlocks || sc.codeBlocks || []).forEach((code, i) => blocks.push({ key: sceneBlockKey(sc, i), code, sceneId: sc.id }));
	}
	sessionBlocks.forEach((code, i) => blocks.push({ key: sessionBlockKey(i), code, sceneId: null }));
	return { blocks, sceneBlocks, sessionBlocks };
}

function blockLabel(key) {
	return key.startsWith('block:') ? `block ${key.slice(6)}` : `scene block ${key.split('#')[1] || ''}`.trim();
}

/**
 * Hot reload: re-run only the blocks whose code changed and keep the rest of
 * the world running. Objects a changed block made are snapshotted (position,
 * rotation, scale, userData.velocity, ammo body velocity) by name, torn down
 * with that block's callbacks/timers/listeners, and restored onto the new
 * objects with the same names. gs.state / window.gsState are untouched.
 * A syntax error changes nothing; a runtime error rolls that block back to
 * its last working code. Only if the rollback fails too does it fall back to
 * a full clear-and-re-run.
 */
async function hotReloadFromEditor({ fromLive = false } = {}) {
	if (!dchatCodeEditor || codeEditorApplying) return;
	codeEditorApplying = true;
	if (dchatCodeApply) dchatCodeApply.disabled = true;
	const text = dchatCodeEditor.value;
	try {
		const { blocks, sceneBlocks, sessionBlocks } = parseCodeEditorBlocks(text);
		const wanted = new Map(blocks.map((b) => [b.key, b]));
		const changed = [];
		for (const b of blocks) {
			const rt = _blockRuntimes.get(b.key);
			if (!rt || rt.code.trim() !== b.code.trim()) changed.push(b);
		}
		const removed = [..._blockRuntimes.values()].filter((rt) => !rt.key.startsWith('adhoc:') && !wanted.has(rt.key));
		if (!changed.length && !removed.length) {
			codeEditorDirty = false;
			setCodeEditorStatus('Hot reload: no code changes', 'ok');
			return;
		}
		// 1. Compile every changed block first: a typo must not touch the scene.
		const compiled = new Map();
		for (const b of changed) {
			try {
				compiled.set(b.key, compileVrBlock(b.code));
			} catch (err) {
				codeEditorDirty = true;
				setCodeEditorStatus(`Syntax error in ${blockLabel(b.key)}: ${err.message} (scene unchanged)`, 'error');
				return;
			}
		}
		setCodeEditorStatus(fromLive ? 'Hot reloading…' : 'Applying (hot reload)…', 'pending');
		// 2. Commit the new code to the model.
		if (activeScene && sceneBlocks) activeScene.codeBlocks = sceneBlocks;
		executedCodeBlocks = sessionBlocks;
		// 3. Drop blocks that were deleted from the editor.
		for (const rt of removed) teardownBlock(rt);
		// 4. Swap each changed block in place.
		const errors = [];
		let restoredCount = 0;
		for (const b of changed) {
			const old = _blockRuntimes.get(b.key) || null;
			const snap = old ? snapshotBlockState(old) : null;
			if (old) teardownBlock(old);
			try {
				const rt = await runTrackedBlock(b.code, b.key, { hot: true, compiled: compiled.get(b.key) });
				restoredCount += restoreBlockState(snap, rt);
			} catch (err) {
				console.error(`Hot reload: ${blockLabel(b.key)} failed`, err);
				const partial = _blockRuntimes.get(b.key);
				if (partial) teardownBlock(partial);
				if (!old) { errors.push({ b, err, rolledBack: false }); continue; }
				// Roll this block back to its last working code, state intact.
				try {
					const rt = await runTrackedBlock(old.code, b.key, { hot: true });
					restoreBlockState(snap, rt);
					setModelBlockCode(b, old.code);
					errors.push({ b, err, rolledBack: true });
				} catch (rollbackErr) {
					throw new Error(`${blockLabel(b.key)}: ${err.message}; rollback also failed (${rollbackErr.message})`);
				}
			}
		}
		updateCodeEditorHint();
		renderDomSceneList();
		if (errors.length) {
			const e = errors[0];
			codeEditorDirty = true;
			setCodeEditorStatus(
				`Error in ${blockLabel(e.b.key)}: ${e.err?.message || e.err}` +
				(e.rolledBack ? ' (kept the previous version running)' : ''),
				'error'
			);
			return;
		}
		codeEditorLastApplied = buildCodeEditorSource();
		// Creation context: a hot-reloaded edit is a code edit like a full Apply.
		GSContext.recordCodeEdit({ code: codeEditorLastApplied, source: fromLive ? 'live' : 'apply' });
		codeEditorDirty = false;
		const n = changed.length;
		setCodeEditorStatus(
			`Hot reloaded ${n} block${n === 1 ? '' : 's'}` +
			(removed.length ? `, removed ${removed.length}` : '') +
			(restoredCount ? ' · state kept' : ''),
			'ok'
		);
	} catch (err) {
		// Last resort: the old clear-and-re-run of everything.
		console.error('Hot reload failed, doing a full reset:', err);
		codeEditorApplying = false;
		await applyCodeFromEditor({ fromLive });
		const cur = dchatCodeStatus ? dchatCodeStatus.textContent : '';
		setCodeEditorStatus(`Hot reload failed (${err.message}) · did a full reset. ${cur}`, dchatCodeStatus?.className || 'error');
		return;
	} finally {
		codeEditorApplying = false;
		if (dchatCodeApply) dchatCodeApply.disabled = false;
	}
}

function setModelBlockCode(b, code) {
	if (b.sceneId) {
		const sc = activeScene && activeScene.id === b.sceneId ? activeScene : null;
		const i = Number(b.key.split('#').pop());
		if (sc && sc.codeBlocks && i < sc.codeBlocks.length) sc.codeBlocks[i] = code;
	} else {
		const i = Number(b.key.slice(6));
		if (i < executedCodeBlocks.length) executedCodeBlocks[i] = code;
	}
}

function updateCodeEditorHint() {
	if (!dchatCodeHint) return;
	const sceneCount = activeScene?.codeBlocks?.length || 0;
	const sessionCount = executedCodeBlocks.length;
	dchatCodeHint.textContent =
		`Scene: ${sceneCount} block${sceneCount === 1 ? '' : 's'} · Session: ${sessionCount} block${sessionCount === 1 ? '' : 's'}. ` +
		`Apply / Live hot reload only changed blocks and keep state; Full reset re-runs everything. ` +
		`Markers like // --- block N --- separate blocks.`;
}

function syncCodeEditorFromState({ force = false } = {}) {
	if (!dchatCodeEditor) return;
	if (codeEditorDirty && !force) return;
	const src = buildCodeEditorSource();
	dchatCodeEditor.value = src;
	codeHighlightApi?.refresh();
	codeEditorLastApplied = src;
	codeEditorDirty = false;
	updateCodeEditorHint();
	if (!codeEditorApplying) setCodeEditorStatus(src ? 'Synced' : 'Empty', '');
}

function notifyCodeEditorExternalChange() {
	// Refresh when chat/scenes change, unless the user is mid-edit.
	syncCodeEditorFromState({ force: false });
	updateCodeEditorHint();
}

function markCodeEditorDirty() {
	codeEditorDirty = true;
	setCodeEditorStatus('Edited', 'pending');
	if (dchatCodeLive && dchatCodeLive.checked) scheduleLiveCodeApply();
}

function scheduleLiveCodeApply() {
	if (codeEditorLiveTimer) clearTimeout(codeEditorLiveTimer);
	codeEditorLiveTimer = setTimeout(() => {
		codeEditorLiveTimer = null;
		hotReloadFromEditor({ fromLive: true });
	}, CODE_EDITOR_LIVE_DEBOUNCE_MS);
}

async function applyCodeFromEditor({ fromLive = false } = {}) {
	if (!dchatCodeEditor || codeEditorApplying) return;
	codeEditorApplying = true;
	setCodeEditorStatus(fromLive ? 'Live applying…' : 'Applying…', 'pending');
	if (dchatCodeApply) dchatCodeApply.disabled = true;
	try {
		const text = dchatCodeEditor.value;
		const { sceneBlocks, sessionBlocks } = parseCodeEditorSource(text);

		if (activeScene && sceneBlocks) activeScene.codeBlocks = sceneBlocks;
		executedCodeBlocks = sessionBlocks;

		clearUserObjects();
		const sc = activeScene;
		const codes = sc?.codeBlocks || [];
		for (let i = 0; i < codes.length; i++) {
			await executeVrCode(codes[i], sceneBlockKey(sc, i));
		}
		for (let i = 0; i < executedCodeBlocks.length; i++) {
			await executeVrCode(executedCodeBlocks[i], sessionBlockKey(i));
		}

		const normalized = buildCodeEditorSource();
		codeEditorLastApplied = normalized;
		GSContext.recordCodeEdit({ code: normalized, source: fromLive ? 'live' : 'apply' });
		// Keep caret-friendly: only rewrite textarea if markers/order changed meaningfully
		if (!codeEditorDirty || dchatCodeEditor.value.trim() === text.trim()) {
			dchatCodeEditor.value = normalized;
			codeHighlightApi?.refresh();
			codeEditorDirty = false;
		} else {
			codeEditorDirty = false;
		}
		updateCodeEditorHint();
		setCodeEditorStatus('Full reset: scene rebuilt from code', 'ok');
		renderDomSceneList();
	} catch (err) {
		console.error('Code editor apply error:', err);
		setCodeEditorStatus(`Error: ${err?.message || err}`, 'error');
		// Don't crash the app; scene may be partially rebuilt — leave editor dirty
		codeEditorDirty = true;
	} finally {
		codeEditorApplying = false;
		if (dchatCodeApply) dchatCodeApply.disabled = false;
	}
}

function revertCodeEditor() {
	if (!dchatCodeEditor) return;
	if (codeEditorLiveTimer) {
		clearTimeout(codeEditorLiveTimer);
		codeEditorLiveTimer = null;
	}
	const src = codeEditorLastApplied || buildCodeEditorSource();
	dchatCodeEditor.value = src;
	codeHighlightApi?.refresh();
	codeEditorDirty = false;
	updateCodeEditorHint();
	setCodeEditorStatus('Reverted', '');
}

function clearUserObjects() {
	// Full reset: stop every block's timers/listeners/dispose hooks and forget
	// hot-reload state (scene objects are removed wholesale below).
	for (const rt of _blockRuntimes.values()) {
		for (const fn of rt.disposers) { try { fn(); } catch { /* ignore */ } }
		for (const id of rt.timeouts) window.clearTimeout(id);
		for (const id of rt.intervals) window.clearInterval(id);
		for (const id of rt.rafs) window.cancelAnimationFrame(id);
		for (const [target, type, fn, opts] of rt.listeners) { try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ } }
	}
	_blockRuntimes.clear();
	_blockStates.clear();
	window.gsState = {};
	// Stop p5 sketches / drop canvas surfaces and scene-owned gamepad hooks
	// before the meshes and _vrAnimations they live in are thrown away.
	for (const surf of [...gsSurfaces]) {
		try { surf.dispose(); } catch (e) { console.error('surface dispose failed:', e); }
	}
	if (typeof gsGamepad !== 'undefined') gsGamepad._reset();
	for (let i = scene.children.length - 1; i >= 0; i--) {
		const child = scene.children[i];
		if (!systemObjectIds.has(child.uuid)) {
			scene.remove(child);
			disposeRecursive(child);
		}
	}
	// Walk-in-AR / the origin rotation may have adopted user meshes under
	// arPlacementRoot or gsOriginRoot (system objects), so also strip those —
	// keep the placement marker and the origin root itself.
	for (const child of userContentRoots()) {
		if (child.parent) child.parent.remove(child);
		disposeRecursive(child);
	}
	window._vrAnimations = [];
	// Scene code's gsPassthroughTexture() no longer holds the camera (the chat preview may).
	gsCamPipeline.resetScene();
	const overlay = document.getElementById('overlay-root');
	for (let i = overlay.children.length - 1; i >= 0; i--) {
		const child = overlay.children[i];
		if (child.id && !systemOverlayIds.has(child.id)) {
			overlay.removeChild(child);
		}
	}
}

/** Clear scene = start a new blank scene: every user-placed object, the
 *  loaded scene and its chat history go. Files library and Community uploads
 *  are not affected. */
async function clearSceneContent() {
	if (!activeScene && userContentRoots().length === 0 && executedCodeBlocks.length === 0 && messages.length === 0) {
		recenterOrbitPivot();
		updateStatus('Scene is already empty', '');
		return;
	}
	if (!await gsConfirm(
		'Clear the scene? All objects and this scene\'s chat history are removed. Files library and Community uploads are not affected.',
		{ title: 'Clear scene', okLabel: 'Clear scene', danger: true }
	)) return;

	setActiveScene(null);
	recenterOrbitPivot();
	updateStatus('Scene cleared', 'connected');
}

/** Make `sc` (a scene record, or null for a blank scene) the one active
 *  scene. Everything the old scene made is stopped and removed, its
 *  chat-built blocks are dropped and the chat starts over, so the chat only
 *  ever shows the active scene's history. Callers then run the new scene's
 *  code and restore its creation history (loadSceneData). */
function setActiveScene(sc) {
	sceneEpoch += 1;
	communityLoadTicket += 1; // a slower Community fetch must not replace this scene
	clearUserObjects();
	executedCodeBlocks = [];
	activeScene = sc;
	resetSceneChat();
	syncCodeEditorFromState({ force: true });
	renderDomSceneList();
	refreshExportPermissionUi();
}

/** Chat back to a fresh start: API history, bubbles (desktop + VR) and the
 *  creation-context session log. */
function resetSceneChat() {
	messages = [];
	displayMessages = [{ role: 'assistant', content: WELCOME_MSG }];
	GSContext.resetSession();
	renderDomChat();
}

function showExportModal() {
	exportNameInput.value = activeScene?.name || 'My Scene';
	exportExtInput.value = sceneFileExtension;
	pendingExportThumbnail = null;
	exportPreview.innerHTML = '<span style="color:rgba(255,255,255,0.4);font-size:12px;text-align:center">No screenshot</span>';
	exportModal.style.display = 'flex';
}

function hideExportModal() {
	exportModal.style.display = 'none';
}

// Gathers the current exportable scene (the active scene + the code chat
// added to it) into the on-disk/on-wire scene format.
// Shared by "Export" (save to server), "Save to Device" (local download),
// and "Upload Current Scene" (community).
function buildSceneData(name) {
	const codeBlocks = [...(activeScene?.codeBlocks || []), ...executedCodeBlocks];

	return {
		version: 1,
		name,
		createdAt: new Date().toISOString(),
		thumbnail: pendingExportThumbnail || '',
		...environmentHdriForScene(), // { environmentHdri } when an HDRI is active (URL ones; files on upload)
		codeBlocks,
		...originRotationForScene(), // { originRotation } only when rotated
		...GSMerge.sceneCredits(activeScene) // mergedFrom / credits of a merged scene
	};
}

async function doExport() {
	if (!sceneExportsAllowed()) { hideExportModal(); showExportsBlocked(); return; }
	const name = exportNameInput.value.trim() || 'Untitled';
	const ext = exportExtInput.value.trim().replace(/^\./, '') || 'vrscene';
	sceneFileExtension = ext;

	// Saved scenes carry their creation context (chat + info log, scrubbed).
	const sceneData = await GSContext.withCreationContext(buildSceneData(name));

	fetch('/api/save-scene', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(sceneData)
	}).then(res => res.json()).then(data => {
		if (data.error) {
			updateStatus(`Export error: ${data.error}`, 'error');
		} else {
			updateStatus(`Exported "${name}" to server`, 'connected');
		}
	}).catch(err => {
		updateStatus(`Export error: ${err.message}`, 'error');
	});

	hideExportModal();
}

function downloadSceneBlob(sceneData, filename) {
	const blob = new Blob([JSON.stringify(sceneData, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30000);
	return blob;
}

function sceneFileStem(name) {
	return String(name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'Untitled';
}

// Downloads the current scene as a local file (a real save-to-disk, unlike
// "Export" above which only saves to this server's single scene slot).
async function doDownloadExport() {
	if (!sceneExportsAllowed()) { hideExportModal(); showExportsBlocked(); return; }
	const name = exportNameInput.value.trim() || 'Untitled';
	const ext = exportExtInput.value.trim().replace(/^\./, '') || 'vrscene';
	sceneFileExtension = ext;

	const sceneData = await GSContext.withCreationContext(buildSceneData(name));
	const filename = `${sceneFileStem(name)}.${ext}`;
	downloadSceneBlob(sceneData, filename);

	updateStatus(`Saved "${name}" to your device`, 'connected');
	hideExportModal();
}

// Share tab: download the current scene as a .vrscene.json file, the same
// JSON format Import .vrscene.json accepts (code, name, creation context).
async function downloadVrsceneJson() {
	if (!sceneExportsAllowed()) { showExportsBlocked(); return; }
	const name = activeScene?.name || 'Untitled';
	const sceneData = await GSContext.withCreationContext(buildSceneData(name));
	const filename = `${sceneFileStem(name)}.vrscene.json`;
	downloadSceneBlob(sceneData, filename);
	updateStatus(`Saved "${filename}" to your device`, 'connected');
	return { filename, sceneData };
}

// Loads a scene record (file import, the server-saved slot, Community, share
// links) as the one active scene: the old scene, its chat-built code and its
// chat history are replaced, never stacked. Resolves once its code has run,
// with the HDRI promise (a note when the scene's HDRI couldn't load).
async function loadSceneData(data, fallbackName, { key, source = 'file', extra = null } = {}) {
	if (!data || !Array.isArray(data.codeBlocks)) {
		throw new Error('Invalid scene data: missing codeBlocks');
	}
	const sc = {
		id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
		name: data.name || fallbackName,
		thumbnail: (data.thumbnail && typeof data.thumbnail === 'object' && data.thumbnail.url)
			? data.thumbnail.url
			: (typeof data.thumbnail === 'string' ? data.thumbnail : (data.thumbUrl || '')),
		codeBlocks: data.codeBlocks,
		createdAt: data.createdAt || new Date().toISOString(),
		...(Array.isArray(data.mergedFrom) ? { mergedFrom: data.mergedFrom } : {}),
		...extra
	};
	setActiveScene(sc);
	const hdriApplied = applySceneEnvironmentHdri(data);
	applySceneOriginRotation(data);
	await runLoadedSceneCode(sc);
	if (activeScene !== sc) return { sc, hdriApplied }; // replaced while its code ran
	notifyCodeEditorExternalChange();
	GSContext.restoreFromScene(data, { key, source }).catch(err => console.warn('creation context restore failed:', err));
	return { sc, hdriApplied };
}

function runLoadedSceneCode(sc) {
	recenterOrbitPivot();
	const blocks = sc.codeBlocks || [];
	return Promise.all(blocks.map((code, i) =>
		Promise.resolve(executeVrCode(code, sceneBlockKey(sc, i))).catch(err => {
			console.error(`Scene "${sc.name}" load error:`, err);
		})
	));
}

function reportSceneLoaded({ sc, hdriApplied }) {
	updateStatus(`Loaded "${sc.name}"`, 'connected');
	hdriApplied.then((note) => { if (note && activeScene === sc) updateStatus(`Loaded "${sc.name}"${note}`, 'error'); });
	return sc;
}

function loadSceneFile(file) {
	const reader = new FileReader();
	reader.onload = (e) => {
		let data;
		try {
			data = JSON.parse(e.target.result);
		} catch (err) {
			console.error('Error parsing scene file:', err);
			updateStatus(`Load error: ${err.message}`, 'error');
			return;
		}
		loadSceneData(data, file.name.replace(/\.(vrscene\.json|vrscene|json)$/i, '')).then(reportSceneLoaded).catch(err => {
			console.error('Error loading scene file:', err);
			updateStatus(`Load error: ${err.message}`, 'error');
		});
	};
	reader.readAsText(file);
}

fileInput.addEventListener('change', (e) => {
	const file = e.target.files[0];
	if (file) loadSceneFile(file);
	fileInput.value = '';
});

function loadSceneFromServer() {
	updateStatus('Loading scene...', 'connecting');
	fetch('/api/load-scene')
		.then(res => {
			if (!res.ok) throw new Error(res.status === 404 ? 'No saved scene found' : 'Server error');
			return res.json();
		})
		.then(data => loadSceneData(data, 'Loaded Scene'))
		.then(reportSceneLoaded)
		.catch(err => {
			updateStatus(`Load error: ${err.message}`, 'error');
		});
}

// --- Community scenes (shared, persistent, server-side via /api/community-scenes) ---
// Shareable URLs: /s/:id (display-only) and /e/:id (editor), plus ?scene=&view=1 / ?display=1.

const shareModal = document.getElementById('share-modal');
const shareModalTitle = document.getElementById('share-modal-title');
const shareDisplayOnly = document.getElementById('share-display-only');
const shareUrlInput = document.getElementById('share-url');
const shareCloseBtn = document.getElementById('share-close-btn');
const shareCopyBtn = document.getElementById('share-copy-btn');
const renameModal = document.getElementById('rename-modal');
const renameNameInput = document.getElementById('rename-name');
const renameCancelBtn = document.getElementById('rename-cancel-btn');
const renameConfirmBtn = document.getElementById('rename-confirm-btn');
const editorLink = document.getElementById('editor-link');

function parseShareRoute() {
	const path = window.location.pathname.replace(/\/+$/, '') || '/';
	const params = new URLSearchParams(window.location.search);
	const embed = parseEmbedRoute(window.location);
	if (embed) return { sceneId: embed.sceneId, displayOnly: true, embed };
	const pathMatch = path.match(/^\/(s|e)\/([A-Za-z0-9_-]+)$/);
	if (pathMatch) {
		return { sceneId: pathMatch[2], displayOnly: pathMatch[1] === 's' };
	}
	return {
		sceneId: params.get('scene'),
		displayOnly: params.get('view') === '1' || params.get('display') === '1'
	};
}

function applyDisplayOnlyMode() {
	displayOnlyMode = true;
	document.body.classList.add('display-only');
	setUiCollapsed(true);
	applyXrPanelVisibility();
	if (typeof setDesktopChatMinimized === 'function') {
		setDesktopChatMinimized(true);
	} else if (desktopChat) {
		desktopChat.classList.add('hidden');
	}
	// XRButton injects a bottom-centered <button> without a stable id.
	for (const btn of document.querySelectorAll('#app button, body > button, #gs-dock button')) {
		const t = (btn.textContent || '').toLowerCase();
		if (t.includes('enter') && (t.includes('ar') || t.includes('vr') || t.includes('xr'))) {
			btn.style.display = 'none';
		}
	}
}

function currentShareUrl() {
	if (!pendingShare) return '';
	return shareDisplayOnly && shareDisplayOnly.checked ? pendingShare.viewUrl : pendingShare.editorUrl;
}

function sharePayloadFromMeta(meta, urls = {}) {
	const origin = window.location.origin;
	const id = meta.id || urls.id;
	const allowExport = (urls.allowExport ?? meta.allowExport) !== false;
	return {
		id,
		name: meta.name || 'Untitled',
		editorUrl: urls.editorUrl || meta.editorUrl || (id ? `${origin}/e/${id}` : ''),
		viewUrl: urls.viewUrl || meta.viewUrl || (id ? `${origin}/s/${id}` : ''),
		allowExport
	};
}

function showShareModal(share) {
	if (displayOnlyMode) return;
	pendingShare = share;
	if (shareModalTitle) shareModalTitle.textContent = share.name ? `Share "${share.name}"` : 'Share Scene';
	if (shareDisplayOnly) shareDisplayOnly.checked = false;
	if (shareUrlInput) shareUrlInput.value = currentShareUrl();
	if (shareCopyBtn) shareCopyBtn.textContent = 'Copy link';
	if (shareModal) shareModal.classList.add('visible');
	if (shareUrlInput) {
		shareUrlInput.focus();
		shareUrlInput.select();
	}
}

function hideShareModal() {
	if (shareModal) shareModal.classList.remove('visible');
}

function showRenameModal(cs, kind = 'scene') {
	if (displayOnlyMode || !cs) return;
	pendingRename = cs;
	pendingRenameKind = kind === 'theme' ? 'theme' : 'scene';
	if (renameNameInput) renameNameInput.value = cs.name || '';
	if (renameModal) renameModal.classList.add('visible');
	setTimeout(() => {
		if (!renameNameInput) return;
		renameNameInput.focus();
		renameNameInput.select();
	}, 0);
}

function hideRenameModal() {
	if (renameModal) renameModal.classList.remove('visible');
	pendingRename = null;
	pendingRenameKind = 'scene';
}

async function copyText(text) {
	if (!text) return false;
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through
	}
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.position = 'fixed';
	ta.style.left = '-9999px';
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try { ok = document.execCommand('copy'); } catch { ok = false; }
	document.body.removeChild(ta);
	return ok;
}

async function uploadCurrentSceneToCommunity({ showShare = true, allowExport = uploadAllowExport } = {}) {
	if (displayOnlyMode) return null;
	const name = activeScene?.name || 'My Scene';
	let sceneData = buildSceneData(name);
	if (sceneData.codeBlocks.length === 0) {
		updateStatus('Nothing to upload - add or load something first', 'error');
		return null;
	}
	// Re-uploading someone else's no-export scene (edited or not) would hand
	// out a copy with exports on.
	if (!sceneExportsAllowed()) {
		showExportsBlocked();
		return null;
	}
	// Ask whether to publish the creation context (chat + files); null = cancelled.
	sceneData = await GSContext.preparePublish(sceneData);
	if (!sceneData) {
		updateStatus('Upload cancelled', '');
		return null;
	}
	// A custom HDRI file from this computer goes up right after the scene.
	const hdriFile = hdriFileForUpload();
	if (hdriFile) sceneData = { ...sceneData, environmentHdri: hdriFile.desc };
	const uploadHdriSig = hdriShareSig();
	// Thumbnail from the initial camera pose (not the current view, and not
	// a leftover export-modal screenshot). Stored separately on the server.
	let thumb = '';
	try { thumb = captureCommunityThumbnail({ initial: true }); } catch (err) { console.warn('Community thumbnail capture failed:', err); }
	sceneData = { ...sceneData, thumbnail: thumb || '' };
	updateStatus('Uploading to community...', 'connecting');
	return fetch('/api/community-scenes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...sceneData, allowExport: allowExport !== false })
	}).then(res => res.json().then(data => ({ ok: res.ok, data }))).then(async ({ ok, data }) => {
		if (!ok || data.error) throw new Error(data.error || 'Upload failed');
		const sceneId = data.id || data.scene?.id;
		rememberOwnerKey(sceneId, data.ownerKey);
		const hdriNote = hdriFile && sceneId ? await uploadSceneHdriFile(sceneId, hdriFile.file) : '';
		const exportsNote = data.allowExport === false ? ' (exports off)' : '';
		updateStatus(`Uploaded "${data.scene?.name || name}" to community${exportsNote}${hdriNote}`, hdriNote ? 'error' : 'connected');
		refreshCommunityScenes();
		const share = sharePayloadFromMeta(data.scene || { name, id: data.id }, { ...data, ownerKey: undefined });
		lastUploadedShare = { sig: shareSignature(sceneData.codeBlocks), share };
		if (showShare) showShareModal(share);
		lastUploadedShare.hdriSig = uploadHdriSig;
		return share;
	}).catch(err => {
		updateStatus(`Upload error: ${err.message}`, 'error');
		return null;
	});
}

// Share tab / VR "Share link": the Community share link for the current
// scene. An unchanged loaded Community scene (or one just uploaded) reuses its
// id; anything else goes through uploadCurrentSceneToCommunity, the same flow
// as Community → Upload Current Scene. Desktop gets the same share modal; in
// VR (modal not visible) the editor link is copied instead.
let lastUploadedShare = null;
/** The Community share payload for the scene as it is now, or null when it
 *  would need an upload first (shareCurrentScene / embedCurrentScene). */
function existingShareForCurrentScene() {
	const sc = activeScene;
	const sig = shareSignature(buildSceneData('').codeBlocks);
	let share = null;
	if (sc && sc.communityId && executedCodeBlocks.length === 0
		&& JSON.stringify(sc.codeBlocks) === sc.communitySig
		&& JSON.stringify(originRotationActive() ? originRotation.rotation : null) === (sc.communityOrigin ?? 'null')) {
		share = sharePayloadFromMeta({ id: sc.communityId, name: sc.name, allowExport: sc.communityAllowExport }, sc);
	} else if (lastUploadedShare && lastUploadedShare.sig === sig) {
		share = lastUploadedShare.share;
	}
	// The environment HDRI is part of what was shared too.
	const hdriSig = hdriShareSig();
	const hdriMatches = (s) => (s === lastUploadedShare?.share ? lastUploadedShare.hdriSig : (sc?.communityHdri ?? 'null')) === hdriSig;
	if (share && !hdriMatches(share)) {
		share = lastUploadedShare && lastUploadedShare.sig === sig && lastUploadedShare.hdriSig === hdriSig ? lastUploadedShare.share : null;
	}
	return share;
}

function shareCurrentScene() {
	if (displayOnlyMode) return Promise.resolve(null);
	const share = existingShareForCurrentScene();
	const copyInXr = (s) => {
		if (s && renderer.xr.isPresenting) {
			copyText(s.editorUrl).then(ok => updateStatus(ok ? `Share link copied: ${s.editorUrl}` : `Share link: ${s.editorUrl}`, 'connected'));
		}
		return s;
	};
	if (!share) return uploadCurrentSceneToCommunity().then(copyInXr); // shows the share modal itself
	if (!renderer.xr.isPresenting) showShareModal(share);
	return Promise.resolve(copyInXr(share));
}

// Share tab / menu "Embed": the <iframe> code for the scene's Community copy
// (embedExport.js). Embedding counts as an export: not offered for a scene
// whose creator turned exports off, and /embed/:id refuses such scenes, so an
// upload made for embedding always has exports allowed.
async function embedCurrentScene() {
	if (displayOnlyMode) return null;
	if (!sceneExportsAllowed()) { showExportsBlocked(); return null; }
	let share = existingShareForCurrentScene();
	if (share && share.allowExport === false) {
		await gsAlert('You turned exports off for this scene, and embedding counts as an export. Turn exports on for it in Community (the "Exports off" button on its row) to embed it.', { title: 'Exports are off' });
		return null;
	}
	if (!share) {
		if (!uploadAllowExport) {
			const ok = await gsConfirm('Embedding counts as an export, so this scene will be uploaded to Community with exports allowed (you chose "Don\'t allow exports"). Continue?', { title: 'Embed scene', okLabel: 'Upload & embed' });
			if (!ok) return null;
		}
		share = await uploadCurrentSceneToCommunity({ showShare: false, allowExport: true });
		if (!share) return null;
	}
	return embedUi.open(share);
}

/** Community row "Embed" (any scene whose creator allows exports). */
function embedCommunityScene(cs) {
	if (!cs?.id) return null;
	if (cs.allowExport === false) { showExportsBlocked(); return null; }
	return embedUi.open(sharePayloadFromMeta(cs));
}

/** Creator-only: turn exports on/off for an uploaded scene (PATCH with the owner key). */
async function setCommunitySceneAllowExport(cs, allowExport) {
	if (!cs?.id || !ownerKeyFor(cs.id)) return false;
	try {
		const res = await fetch(`/api/community-scenes/${encodeURIComponent(cs.id)}`, {
			method: 'PATCH',
			headers: ownerHeaders(cs.id, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({ allowExport })
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
		const on = data.allowExport !== false;
		updateStatus(`Exports ${on ? 'allowed' : 'turned off'} for "${cs.name}"`, 'connected');
		if (lastUploadedShare?.share?.id === cs.id) lastUploadedShare.share.allowExport = on;
		if (activeScene?.communityId === cs.id) activeScene.communityAllowExport = on;
		refreshCommunityScenes();
		return true;
	} catch (err) {
		updateStatus(`Export setting error: ${err.message}`, 'error');
		return false;
	}
}

function refreshCommunityScenes() {
	if (!dchatCommunityList) return;
	dchatCommunityList.innerHTML = '<div class="dchat-scene-empty">Loading...</div>';
	fetch('/api/community-scenes')
		.then(res => res.json().then(data => ({ ok: res.ok, data })))
		.then(({ ok, data }) => {
			if (!ok || data.error) throw new Error(data.error || 'Failed to list community scenes');
			renderCommunitySceneList(data.scenes || []);
		})
		.catch(err => {
			dchatCommunityList.innerHTML = '';
			const empty = document.createElement('div');
			empty.className = 'dchat-scene-empty';
			empty.textContent = err.message;
			dchatCommunityList.appendChild(empty);
		});
}


/** Short local datetime for Community list meta (browser locale / TZ). */
function formatCommunityDate(iso) {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

/** Compact form for XR panel rows. */
function formatCommunityDateShort(iso) {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

/** Resolve created/updated from list payload (createdAt/updatedAt or uploadedAt fallback). */
function communityTimestamps(item) {
	if (!item) return { createdAt: null, updatedAt: null };
	const updatedAt = item.updatedAt || item.uploadedAt || null;
	const createdAt = item.createdAt || updatedAt || null;
	return { createdAt, updatedAt };
}

function communityDatesMetaText(item, { short = false } = {}) {
	const { createdAt, updatedAt } = communityTimestamps(item);
	const fmt = short ? formatCommunityDateShort : formatCommunityDate;
	const created = fmt(createdAt);
	const modified = fmt(updatedAt);
	if (!created && !modified) return '';
	if (created && modified && created === modified) {
		return short ? created : `Created ${created}`;
	}
	const parts = [];
	if (created) parts.push(short ? `C ${created}` : `Created ${created}`);
	if (modified) parts.push(short ? `M ${modified}` : `Modified ${modified}`);
	return parts.join(' · ');
}

function appendCommunityDatesEl(parent, item) {
	const text = communityDatesMetaText(item);
	if (!text) return null;
	const dates = document.createElement('div');
	dates.className = 'dchat-scene-dates';
	dates.textContent = text;
	dates.title = text;
	parent.appendChild(dates);
	return dates;
}

function autosizeCommunityDesc(ta) {
	ta.style.height = 'auto';
	const min = 44;
	const max = 160;
	ta.style.height = Math.min(max, Math.max(min, ta.scrollHeight)) + 'px';
}

/** Save a Community scene's description (PATCH). Same as rename: no owner key required. The key is still sent when this browser has it. */
async function setCommunitySceneDescription(cs, description) {
	if (!cs?.id) return false;
	const text = sanitizeDescription(description);
	try {
		const res = await fetch(`/api/community-scenes/${encodeURIComponent(cs.id)}`, {
			method: 'PATCH',
			headers: ownerHeaders(cs.id, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({ description: text })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
		cs.description = text;
		const cached = communityScenesCache.find((s) => s.id === cs.id);
		if (cached) cached.description = text;
		return true;
	} catch (err) {
		updateStatus(`Description error: ${err.message}`, 'error');
		return false;
	}
}

function bindCommunityDescription(wrap, cs) {
	const initial = typeof cs.description === 'string' ? cs.description : '';
	const ta = document.createElement('textarea');
	ta.className = 'dchat-community-desc';
	ta.setAttribute('data-gs-wrap', '');
	ta.rows = 2;
	ta.maxLength = DESCRIPTION_MAX_CHARS;
	ta.spellcheck = false;
	ta.placeholder = DESCRIPTION_PLACEHOLDER;
	ta.value = initial;
	ta.setAttribute('aria-label', `Description of ${cs.name || 'scene'}`);
	// Don't let a tile-level click (thumb / title load) fire from the field.
	const stop = (e) => e.stopPropagation();
	for (const ev of ['click', 'pointerdown', 'mousedown', 'touchstart']) {
		wrap.addEventListener(ev, stop);
		ta.addEventListener(ev, stop);
	}

	const btnRow = document.createElement('div');
	btnRow.className = 'dchat-community-desc-actions';

	const editBtn = document.createElement('button');
	editBtn.type = 'button';
	editBtn.className = 'dchat-btn dchat-community-desc-edit';
	editBtn.textContent = 'Edit';
	editBtn.setAttribute('aria-label', 'Edit description');

	const saveBtn = document.createElement('button');
	saveBtn.type = 'button';
	saveBtn.className = 'dchat-btn dchat-community-desc-save';
	saveBtn.textContent = 'Save';
	saveBtn.setAttribute('aria-label', 'Save description');

	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'dchat-btn secondary dchat-community-desc-cancel';
	cancelBtn.textContent = 'Cancel';
	cancelBtn.setAttribute('aria-label', 'Cancel description edit');

	let saved = initial;
	let saving = false;
	let editing = false;

	const applyView = () => {
		editing = false;
		ta.readOnly = true;
		ta.classList.add('is-readonly');
		ta.classList.toggle('is-empty', !saved);
		ta.value = saved;
		editBtn.hidden = false;
		saveBtn.hidden = true;
		cancelBtn.hidden = true;
		wrap.classList.remove('is-dirty', 'is-editing');
		autosizeCommunityDesc(ta);
		if (document.activeElement === ta) ta.blur();
	};

	const applyEdit = () => {
		if (editing) return;
		editing = true;
		ta.readOnly = false;
		ta.classList.remove('is-readonly', 'is-empty');
		editBtn.hidden = true;
		saveBtn.hidden = false;
		cancelBtn.hidden = false;
		wrap.classList.add('is-editing');
		setDirty();
		autosizeCommunityDesc(ta);
		if (document.activeElement !== ta) ta.focus();
	};

	const setDirty = () => {
		wrap.classList.toggle('is-dirty', ta.value !== saved);
	};

	const restore = () => {
		ta.value = saved;
		applyView();
	};

	const persist = async () => {
		if (saving) return false;
		if (ta.value === saved) { applyView(); return true; }
		saving = true;
		saveBtn.disabled = true;
		cancelBtn.disabled = true;
		const ok = await setCommunitySceneDescription(cs, ta.value);
		saving = false;
		saveBtn.disabled = false;
		cancelBtn.disabled = false;
		if (ok) {
			saved = sanitizeDescription(ta.value);
			ta.value = saved;
			applyView();
			return true;
		}
		return false;
	};

	editBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); applyEdit(); });
	saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
	cancelBtn.addEventListener('mousedown', (e) => e.preventDefault());
	saveBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); persist(); });
	cancelBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); restore(); });
	ta.addEventListener('input', () => { if (!editing) applyEdit(); autosizeCommunityDesc(ta); setDirty(); });
	ta.addEventListener('focus', () => { if (!editing && !saving) applyEdit(); });
	ta.addEventListener('keydown', (e) => {
		if (!editing) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			restore();
		} else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			persist();
		}
	});

	btnRow.append(editBtn, saveBtn, cancelBtn);
	wrap.append(ta, btnRow);
	queueMicrotask(() => applyView());
}

function communityThumbUrl(cs) {
	if (cs && cs.hasThumbnail && cs.thumbUrl) return cs.thumbUrl;
	if (cs && cs.thumbnail && typeof cs.thumbnail === 'object' && cs.thumbnail.url) return cs.thumbnail.url;
	if (cs && typeof cs.thumbnail === 'string' && (cs.thumbnail.startsWith('data:image/') || cs.thumbnail.startsWith('/'))) return cs.thumbnail;
	return '';
}

function renderCommunitySceneList(scenes) {
	communityScenesCache = scenes;
	if (scenePanelSubTab === 'community') renderDomSceneList();

	dchatCommunityList.innerHTML = '';
	if (scenes.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No community scenes yet. Be the first to upload one!';
		dchatCommunityList.appendChild(empty);
		return;
	}
	for (const cs of scenes) {
		const item = document.createElement('div');
		item.className = 'dchat-scene-item dchat-community-scene';
		item.dataset.sceneId = cs.id || '';

		const thumbWrap = document.createElement('div');
		thumbWrap.className = 'dchat-community-thumb';
		thumbWrap.title = 'Load this scene';
		const thumbSrc = communityThumbUrl(cs);
		if (thumbSrc) {
			const img = document.createElement('img');
			img.alt = '';
			img.src = thumbSrc;
			img.loading = 'lazy';
			img.decoding = 'async';
			img.addEventListener('load', () => thumbWrap.classList.add('has-image'));
			img.addEventListener('error', () => { img.remove(); thumbWrap.classList.remove('has-image'); });
			thumbWrap.appendChild(img);
		}
		thumbWrap.addEventListener('click', (e) => {
			e.stopPropagation();
			loadCommunityScene(cs).catch(() => {});
		});

		const body = document.createElement('div');
		body.className = 'dchat-community-scene-body';

		const nameRow = document.createElement('div');
		nameRow.className = 'dchat-scene-info dchat-community-scene-name-row';

		const name = document.createElement('div');
		name.className = 'dchat-scene-name';
		name.textContent = cs.name;
		name.title = cs.name + (cs.id ? ` (${cs.id})` : '');
		nameRow.appendChild(name);
		appendCommunityDatesEl(nameRow, cs);

		const descWrap = document.createElement('div');
		descWrap.className = 'dchat-community-desc-wrap';

		const actions = document.createElement('div');
		actions.className = 'dchat-scene-actions dchat-community-scene-actions-row';

		const loadKey = communitySceneKeyFrom(cs);
		if (loadKey && activeScene?.communityKey === loadKey) {
			item.classList.add('active');
		}

		const load = document.createElement('button');
		load.className = 'dchat-btn';
		load.textContent = 'Load';
		load.addEventListener('click', () => { loadCommunityScene(cs).catch(() => {}); });

		const share = document.createElement('button');
		share.className = 'dchat-btn';
		share.textContent = 'Share';
		share.addEventListener('click', () => {
			showShareModal(sharePayloadFromMeta(cs));
		});

		const rename = document.createElement('button');
		rename.className = 'dchat-btn';
		rename.textContent = 'Rename';
		rename.addEventListener('click', () => showRenameModal(cs));

		actions.append(load, share, rename);
		// Embed (exports allowed only). The creator also gets an exports toggle.
		const owned = !!ownerKeyFor(cs.id);
		const exportsOff = cs.allowExport === false;
		if (!exportsOff) {
			const embed = document.createElement('button');
			embed.className = 'dchat-btn';
			embed.textContent = 'Embed';
			embed.dataset.communityEmbed = cs.id;
			embed.title = 'HTML code to show this scene on another website';
			embed.addEventListener('click', () => embedCommunityScene(cs));
			actions.appendChild(embed);
		}
		if (exportsOff) {
			const badge = document.createElement('span');
			badge.className = 'dchat-noexport-badge';
			badge.textContent = 'No exports';
			badge.title = 'The creator turned off exports: no 3D model download, embed or code copy';
			nameRow.appendChild(badge);
		}
		if (owned) {
			const toggle = document.createElement('button');
			toggle.className = 'dchat-btn secondary';
			toggle.dataset.communityExportToggle = cs.id;
			toggle.textContent = exportsOff ? 'Allow exports' : 'Block exports';
			toggle.title = exportsOff ? 'You uploaded this scene: let others export and embed it' : 'You uploaded this scene: stop others exporting or embedding it';
			toggle.addEventListener('click', () => setCommunitySceneAllowExport(cs, exportsOff));
			actions.appendChild(toggle);
		}
		GSMerge.decorateCommunityRow(actions, cs); // "Merge" pick button
		bindCommunityDescription(descWrap, cs);
		body.append(nameRow, descWrap, actions);
		item.append(thumbWrap, body);
		dchatCommunityList.appendChild(item);
	}
}

// Identity of a Community scene: server id, else the blob url for legacy
// records that have no id. Marks the Community row of the active scene and
// lets spam-clicks on one row share a single fetch.
function communitySceneKeyFrom(cs) {
	if (!cs) return null;
	const id = cs.id || cs.communityId;
	if (id) return `id:${id}`;
	if (cs.url) return `url:${cs.url}`;
	return null;
}

/** Desktop Community header controls as HTML buttons (not SVG).
 *  SVG mounts use width:100% + meet and grow with panel width/DPI, which
 *  can crush #dchat-community-list to ~0 height on wide desktops. XR still
 *  draws COMMUNITY_BUTTONS via the canvas menuSystem path. */
function mountHtmlActionButtons(container, specs, { accentVariants = ['accent', 'active'] } = {}) {
	if (!container) return;
	container.innerHTML = '';
	for (const spec of specs) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'dchat-btn';
		const v = spec.variant || '';
		if (accentVariants.includes(v)) btn.classList.add('accent');
		else if (v === 'secondary' || v === 'inactiveToggle') btn.classList.add('secondary');
		btn.textContent = spec.label;
		btn.dataset.action = spec.action;
		btn.addEventListener('click', () => handleMenuAction(spec.action));
		container.appendChild(btn);
	}
}

function renderCommunityDesktopButtons() {
	mountHtmlActionButtons(dchatCommunityButtonsMount, COMMUNITY_BUTTONS);
	// Upload choice: allow or don't allow others to export the uploaded scene.
	if (!dchatCommunityButtonsMount) return;
	const label = document.createElement('label');
	label.className = 'dchat-upload-allow-export';
	label.title = 'Unchecked: people can view the scene but not download it as a 3D model, embed it or save its code';
	const box = document.createElement('input');
	box.type = 'checkbox';
	box.id = 'dchat-upload-allow-export';
	box.checked = uploadAllowExport;
	box.addEventListener('change', () => setUploadAllowExport(box.checked));
	label.append(box, document.createTextNode(' Allow others to export uploads'));
	dchatCommunityButtonsMount.appendChild(label);
}

function enqueueCommunityApply(fn) {
	const apply = communityApplyChain.then(fn, fn);
	communityApplyChain = apply.then(() => {}, () => {});
	return apply;
}

// What shareCurrentScene needs to tell "unchanged since it was loaded".
function communitySceneFields(data, key) {
	const communityAllowExport = data.allowExport !== false;
	return {
		communityAllowExport,
		// Locked for everyone but the creator (isOwner: the server checked our owner key).
		exportLocked: !communityAllowExport && !data.isOwner,
		communityKey: key,
		communityId: data.id || (key.startsWith('id:') ? key.slice(3) : null),
		communityHdri: environmentHdriSignature(data.environmentHdri),
		communitySig: JSON.stringify(data.codeBlocks),
		communityOrigin: JSON.stringify(isIdentityOriginRotation(data.originRotation) ? null : normalizeOriginRotation(data.originRotation)),
		...(data.editorUrl ? { editorUrl: data.editorUrl } : {}),
		...(data.viewUrl ? { viewUrl: data.viewUrl } : {})
	};
}

function finishCommunityLoadUi() {
	notifyCodeEditorExternalChange();
	if (dchatCommunityList && communityScenesCache.length) renderCommunitySceneList(communityScenesCache);
	else renderDomSceneList();
}

/** Load a Community scene as the active scene (replacing the current one).
 *  The newest click wins: an older fetch that lands later is dropped, as is
 *  one that lands after any other scene was loaded. */
function loadCommunityScene(cs) {
	const name = (cs && cs.name) || 'Community scene';
	const key = communitySceneKeyFrom(cs);
	if (!key) {
		const err = new Error('Community scene has no id');
		updateStatus(`Load error: ${err.message}`, 'error');
		return Promise.reject(err);
	}

	const inflight = communityLoadInflight.get(key);
	// Reuse only a still-current fetch. A superseded one resolves to null and
	// must not swallow a newer click on the same scene.
	if (inflight && inflight.ticket === communityLoadTicket) {
		updateStatus(`Loading "${name}"...`, 'connecting');
		return inflight.promise;
	}

	const ticket = ++communityLoadTicket;
	updateStatus(`Loading "${name}"...`, 'connecting');
	const fetchUrl = cs.id ? `/api/community-scenes/${encodeURIComponent(cs.id)}${embedRoute ? '?embed=1' : ''}` : cs.url;

	const promise = fetch(fetchUrl, cs.id ? { headers: ownerHeaders(cs.id) } : undefined)
		.then(async res => {
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				const err = new Error(body.error || 'Failed to fetch community scene');
				err.status = res.status;
				err.exportsDisabled = !!body.exportsDisabled;
				throw err;
			}
			return res.json();
		})
		.then(data => enqueueCommunityApply(async () => {
			if (!data || !Array.isArray(data.codeBlocks)) {
				throw new Error('Invalid scene data: missing codeBlocks');
			}
			if (ticket !== communityLoadTicket) return null;
			// Prefer the id we asked for so list rows and the fetched record match.
			const resolvedKey = communitySceneKeyFrom({ id: cs.id || data.id, url: cs.url || data.url }) || key;
			const loaded = await loadSceneData(data, data.name || name, { key: resolvedKey, source: 'community', extra: communitySceneFields(data, resolvedKey) });
			finishCommunityLoadUi();
			return reportSceneLoaded(loaded);
		}))
		.catch(err => {
			updateStatus(`Load error: ${err.message}`, 'error');
			throw err;
		})
		.finally(() => {
			const cur = communityLoadInflight.get(key);
			if (cur && cur.promise === promise) communityLoadInflight.delete(key);
		});

	communityLoadInflight.set(key, { promise, ticket });
	return promise;
}

async function loadCommunitySceneById(sceneId, { activate = true } = {}) {
	if (!activate) {
		const res = await fetch(`/api/community-scenes/${encodeURIComponent(sceneId)}`);
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || 'Scene not found');
		return data;
	}
	const sc = await loadCommunityScene({ id: sceneId, name: 'Shared Scene' });
	if (!sc) throw new Error('Scene not found');
	return sc;
}

async function renameCommunityScene() {
	const cs = pendingRename;
	const kind = pendingRenameKind;
	const name = renameNameInput ? renameNameInput.value.trim() : '';
	if (!cs || !cs.id) {
		hideRenameModal();
		return;
	}
	if (!name) {
		updateStatus('Name cannot be empty', 'error');
		return;
	}
	hideRenameModal();
	try {
		if (kind === 'theme') {
			const res = await fetch(`/api/community-themes/${encodeURIComponent(cs.id)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
			updateStatus(`Renamed theme to "${data.theme?.name || name}"`, 'connected');
			refreshCommunityThemes();
			return;
		}
		const res = await fetch(`/api/community-scenes/${encodeURIComponent(cs.id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
		updateStatus(`Renamed to "${data.scene?.name || name}"`, 'connected');
		refreshCommunityScenes();
	} catch (err) {
		updateStatus(`Rename error: ${err.message}`, 'error');
	}
}


// --- Community themes (editor chrome) + theme restyle chat ---

const DEFAULT_THEME = {
	name: 'Default',
	cssVars: {
		'--dchat-bg': 'rgba(22, 22, 32, 0.85)',
		'--dchat-border': '#ffffff',
		'--dchat-text': '#ffffff',
		'--dchat-text-muted': 'rgba(255, 255, 255, 0.55)',
		'--dchat-header-bg': 'rgba(22, 22, 32, 0.85)',
		'--dchat-tabs-bg': 'rgba(22, 22, 32, 0.85)',
		'--dchat-tab-color': 'rgba(255, 255, 255, 0.5)',
		'--dchat-tab-active-bg': '#4f46e5',
		'--dchat-tab-active-color': '#ffffff',
		'--dchat-input-bg': 'rgba(255, 255, 255, 0.1)',
		'--dchat-accent': '#6d28d9',
		'--dchat-accent-2': '#4f46e5',
		'--dchat-radius': '18px',
		'--dchat-font': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
	},
	customCSS: ''
};

function getThemeStyleEl() {
	let el = document.getElementById('dchat-theme-style');
	if (!el) {
		el = document.createElement('style');
		el.id = 'dchat-theme-style';
		document.head.appendChild(el);
	}
	return el;
}

function applyTheme(theme, { announce = false } = {}) {
	if (!desktopChat || !theme || !theme.cssVars) return;
	const vars = theme.cssVars;
	// Clear previous custom vars by resetting known keys to defaults first
	for (const k of Object.keys(DEFAULT_THEME.cssVars)) {
		desktopChat.style.removeProperty(k);
	}
	for (const [k, v] of Object.entries(vars)) {
		if (typeof k === 'string' && k.startsWith('--') && typeof v === 'string') {
			desktopChat.style.setProperty(k, v);
		}
	}
	const styleEl = getThemeStyleEl();
	const custom = typeof theme.customCSS === 'string' ? theme.customCSS : '';
	// Soft-scope: only keep rules that mention #desktop-chat, or wrap bare rules.
	styleEl.textContent = custom ? custom : '';
	currentTheme = {
		name: theme.name || 'Custom',
		cssVars: { ...vars },
		customCSS: custom
	};
	cacheLastTheme(currentTheme);
	if (announce) updateStatus(`Theme: ${currentTheme.name}`, 'connected');
}

const THEME_CACHE_KEY = 'carljr-theme';
// This preference always persists. Absent or anything other than '1' means off.
const THEME_REMEMBER_KEY = 'carljr-theme-remember';

function loadRememberTheme() {
	try {
		return localStorage.getItem(THEME_REMEMBER_KEY) === '1';
	} catch { /* ignore */ }
	return false;
}

let rememberTheme = loadRememberTheme();

function syncRememberThemeCheckboxes() {
	if (dchatThemeRemember) dchatThemeRemember.checked = rememberTheme;
	if (dchatThemeRememberCommunity) dchatThemeRememberCommunity.checked = rememberTheme;
}

function setRememberTheme(on) {
	rememberTheme = !!on;
	try {
		localStorage.setItem(THEME_REMEMBER_KEY, rememberTheme ? '1' : '0');
	} catch { /* ignore quota */ }
	syncRememberThemeCheckboxes();
	cacheLastTheme(currentTheme || DEFAULT_THEME);
	renderDomChat();
	if (scenePanelSubTab === 'community' && communitySection === 'themes') renderDomSceneList();
}

function cacheLastTheme(theme) {
	try {
		// Remember-theme is opt-in. While it is off, drop any previously saved theme
		// so a later visit cannot restore it and live edits are not written.
		if (!rememberTheme) {
			localStorage.removeItem(THEME_CACHE_KEY);
			return;
		}
		if (!theme || !theme.cssVars) return;
		localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
			name: theme.name || 'Custom',
			cssVars: { ...theme.cssVars },
			customCSS: typeof theme.customCSS === 'string' ? theme.customCSS : ''
		}));
	} catch { /* ignore quota */ }
}

function loadCachedTheme() {
	try {
		const raw = localStorage.getItem(THEME_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed && parsed.cssVars && typeof parsed.cssVars === 'object') return parsed;
	} catch { /* ignore */ }
	return null;
}

function snapshotCurrentTheme(name) {
	const cssVars = {};
	const cs = desktopChat ? getComputedStyle(desktopChat) : null;
	for (const k of Object.keys(DEFAULT_THEME.cssVars)) {
		let v = desktopChat?.style?.getPropertyValue(k)?.trim();
		if (!v && cs) v = cs.getPropertyValue(k)?.trim();
		if (!v) v = DEFAULT_THEME.cssVars[k];
		cssVars[k] = v;
	}
	// Also pick up any extra --dchat-* set inline
	if (desktopChat?.style) {
		for (let i = 0; i < desktopChat.style.length; i++) {
			const prop = desktopChat.style.item(i);
			if (prop.startsWith('--') && !(prop in cssVars)) {
				cssVars[prop] = desktopChat.style.getPropertyValue(prop).trim();
			}
		}
	}
	const styleEl = document.getElementById('dchat-theme-style');
	return {
		name: name || currentTheme?.name || 'My Theme',
		cssVars,
		customCSS: styleEl?.textContent || currentTheme?.customCSS || ''
	};
}

function parseThemeJsonBlocks(text) {
	const themes = [];
	const displayText = String(text || '').replace(/```theme-json\n([\s\S]*?)```/g, (match, body) => {
		try {
			const obj = JSON.parse(body.trim());
			if (obj && obj.cssVars && typeof obj.cssVars === 'object') {
				themes.push({
					name: obj.name || 'AI Theme',
					cssVars: obj.cssVars,
					customCSS: typeof obj.customCSS === 'string' ? obj.customCSS : ''
				});
				return `[Applied theme "${obj.name || 'AI Theme'}"]`;
			}
		} catch { /* ignore bad JSON */ }
		return '[Invalid theme-json block]';
	});
	// Also accept ```theme-css fences as customCSS-only overlays
	const withCss = displayText.replace(/```theme-css\n([\s\S]*?)```/g, (match, body) => {
		themes.push({
			name: currentTheme?.name || 'Custom CSS',
			cssVars: { ...(currentTheme?.cssVars || DEFAULT_THEME.cssVars) },
			customCSS: body.trim()
		});
		return '[Applied theme CSS]';
	});
	return { displayText: withCss.trim(), themes };
}

function setCommunitySection(section) {
	communitySection = section === 'themes' ? 'themes' : 'scenes';
	document.querySelectorAll('#dchat-community-subtabs .dchat-subtab').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.communitySection === communitySection);
	});
	const scenesSec = document.getElementById('dchat-community-section-scenes');
	const themesSec = document.getElementById('dchat-community-section-themes');
	if (scenesSec) scenesSec.classList.toggle('active', communitySection === 'scenes');
	if (themesSec) themesSec.classList.toggle('active', communitySection === 'themes');
	if (communitySection === 'themes') refreshCommunityThemes();
	else refreshCommunityScenes();
}

function setChatSection(section) {
	chatSection = section === 'theme' || section === 'prompt' ? section : 'scene';
	document.querySelectorAll('#dchat-chat-subtabs .dchat-subtab').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.chatSection === chatSection);
	});
	const sceneSec = document.getElementById('dchat-chat-section-scene');
	const themeSec = document.getElementById('dchat-chat-section-theme');
	if (sceneSec) sceneSec.classList.toggle('active', chatSection === 'scene');
	if (themeSec) themeSec.classList.toggle('active', chatSection === 'theme');
	const promptSec = document.getElementById('dchat-chat-section-prompt');
	if (promptSec) promptSec.classList.toggle('active', chatSection === 'prompt');
	renderDomChat();
}

async function uploadCurrentThemeToCommunity() {
	if (displayOnlyMode) return;
	const name = await gsPrompt('Theme name?', currentTheme?.name || 'My Theme', { title: 'Upload theme', okLabel: 'Upload' });
	if (name == null) return;
	const theme = snapshotCurrentTheme(name.trim() || 'My Theme');
	updateStatus('Uploading theme...', 'connecting');
	fetch('/api/community-themes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(theme)
	}).then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ ok, data }) => {
		if (!ok || data.error) throw new Error(data.error || 'Upload failed');
		currentTheme = theme;
		cacheLastTheme(theme);
		updateStatus(`Uploaded theme "${data.theme?.name || theme.name}"`, 'connected');
		refreshCommunityThemes();
	}).catch(err => {
		updateStatus(`Theme upload error: ${err.message}`, 'error');
	});
}

function refreshCommunityThemes() {
	const xrThemes = scenePanelSubTab === 'community' && communitySection === 'themes';
	if (!dchatThemesList && !xrThemes) return;
	if (dchatThemesList) dchatThemesList.innerHTML = '<div class="dchat-scene-empty">Loading...</div>';
	fetch('/api/community-themes')
		.then(res => res.json().then(data => ({ ok: res.ok, data })))
		.then(({ ok, data }) => {
			if (!ok || data.error) throw new Error(data.error || 'Failed to list themes');
			renderCommunityThemeList(data.themes || []);
		})
		.catch(err => {
			communityThemesCache = [];
			if (xrThemes) renderDomSceneList();
			if (!dchatThemesList) return;
			dchatThemesList.innerHTML = '';
			const empty = document.createElement('div');
			empty.className = 'dchat-scene-empty';
			empty.textContent = err.message;
			dchatThemesList.appendChild(empty);
		});
}

function renderCommunityThemeList(themes) {
	communityThemesCache = themes;
	if (scenePanelSubTab === 'community' && communitySection === 'themes') renderDomSceneList();
	if (!dchatThemesList) return;
	dchatThemesList.innerHTML = '';
	if (themes.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No community themes yet. Restyle via chat, then upload!';
		dchatThemesList.appendChild(empty);
		return;
	}
	for (const th of themes) {
		const item = document.createElement('div');
		item.className = 'dchat-scene-item';

		const info = document.createElement('div');
		info.className = 'dchat-scene-info';

		const name = document.createElement('div');
		name.className = 'dchat-scene-name';
		name.textContent = th.name;
		name.title = th.name + (th.id ? ` (${th.id})` : '');
		info.appendChild(name);
		appendCommunityDatesEl(info, th);

		const actions = document.createElement('div');
		actions.className = 'dchat-scene-actions';

		const apply = document.createElement('button');
		apply.className = 'dchat-btn accent';
		apply.textContent = 'Apply';
		apply.addEventListener('click', () => applyCommunityTheme(th));

		const rename = document.createElement('button');
		rename.className = 'dchat-btn';
		rename.textContent = 'Rename';
		rename.addEventListener('click', () => showRenameModal(th, 'theme'));

		actions.append(apply, rename);
		item.append(info, actions);
		dchatThemesList.appendChild(item);
	}
}

function applyCommunityTheme(th) {
	updateStatus(`Loading theme "${th.name}"...`, 'connecting');
	const fetchUrl = th.id ? `/api/community-themes/${encodeURIComponent(th.id)}` : th.url;
	fetch(fetchUrl)
		.then(res => {
			if (!res.ok) throw new Error('Failed to fetch theme');
			return res.json();
		})
		.then(data => {
			applyTheme(data, { announce: true });
		})
		.catch(err => {
			updateStatus(`Theme load error: ${err.message}`, 'error');
		});
}

function appendThemeChatBubble(role, content) {
	if (!dchatThemeChatMessages) return;
	const div = document.createElement('div');
	div.className = `dchat-theme-msg ${role}`;
	div.textContent = content;
	dchatThemeChatMessages.appendChild(div);
	dchatThemeChatMessages.scrollTop = dchatThemeChatMessages.scrollHeight;
}

async function sendThemeChat() {
	if (themeChatLoading || displayOnlyMode) return;
	const text = (dchatThemeChatInput?.value || '').trim();
	if (!text && pendingThemeAttachments.length === 0) return;
	if (dchatThemeChatInput) dchatThemeChatInput.value = '';
	const themeAtts = pendingThemeAttachments;
	pendingThemeAttachments = [];
	renderThemeAttachmentChips();
	let userContent = text;
	for (const att of themeAtts.filter(a => a.kind === 'text')) {
		userContent += `\n\n--- File: ${att.name} ---\n${att.text}`;
	}
	const bubbleLabel = text + (themeAtts.length ? `\n\n📄 ${themeAtts.map(a => a.name).join(', ')}` : '');
	themeChatMessages.push({ role: 'user', content: userContent || '(attached files)' });
	appendThemeChatBubble('user', bubbleLabel || '(attached files)');
	themeChatLoading = true;
	if (dchatThemeChatSend) dchatThemeChatSend.disabled = true;
	appendThemeChatBubble('system', thinkingStatusText());
	renderDomChat();
	try {
		let data;
		if (selectedBackend === 'ollama') {
			data = await callOllamaDirect(
				cachedPrompts?.themePrompt || '',
				themeChatMessages.map(m => ({ role: m.role, content: m.content })),
				selectedOllamaModel,
				4096
			);
		} else {
			const response = await fetch('/api/theme-chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: themeChatMessages.map(m => ({ role: m.role, content: m.content })),
					backend: selectedBackend
				})
			});
			const responseText = await response.text();
			try { data = JSON.parse(responseText); }
			catch { throw new Error(`Server returned non-JSON (${response.status}): ${responseText.slice(0, 120)}`); }
			if (!response.ok) throw new Error(data.error || `API error: ${response.status}`);
		}
		const rawText = data.content?.[0]?.text || data.content || 'No response';
		const raw = typeof rawText === 'string' ? rawText : (Array.isArray(rawText) ? rawText.map(p => p.text || '').join('') : String(rawText));
		themeChatMessages.push({ role: 'assistant', content: raw });
		const { displayText, themes } = parseThemeJsonBlocks(raw);
		// Remove "Thinking..." bubble
		if (dchatThemeChatMessages?.lastChild?.classList?.contains('system')) {
			dchatThemeChatMessages.lastChild.remove();
		}
		appendThemeChatBubble('assistant', displayText || '(theme applied)');
		if (themes.length > 0) {
			applyTheme(themes[themes.length - 1], { announce: true });
		}
	} catch (err) {
		if (dchatThemeChatMessages?.lastChild?.classList?.contains('system')) {
			dchatThemeChatMessages.lastChild.remove();
		}
		appendThemeChatBubble('system', `Error: ${err.message}`);
		updateStatus(`Theme chat error: ${err.message}`, 'error');
	} finally {
		themeChatLoading = false;
		if (dchatThemeChatSend) dchatThemeChatSend.disabled = false;
		renderDomChat();
	}
}

async function bootSharedScene() {
	const route = parseShareRoute();
	if (route.embed) return bootEmbedScene(route);
	if (route.displayOnly) applyDisplayOnlyMode();

	try {
		await new Promise((resolve) => {
			// Kick a refresh without blocking forever if Blob isn't configured.
			const p = fetch('/api/community-scenes')
				.then(res => res.json().then(data => ({ ok: res.ok, data })))
				.then(({ ok, data }) => {
					if (ok && !data.error) renderCommunitySceneList(data.scenes || []);
				})
				.catch(() => {})
				.finally(resolve);
			return p;
		});
	} catch {
		// ignore
	}

	if (!route.sceneId) return;

	try {
		updateStatus('Loading scene...', 'connecting');
		const sc = await loadCommunitySceneById(route.sceneId, { activate: true });
		document.title = sc.name ? `${sc.name} — GS For Anything` : 'GS For Anything';
		if (editorLink) editorLink.href = sc.editorUrl || `/e/${route.sceneId}`;
		updateStatus(route.displayOnly ? '' : `Loaded "${sc.name}"`, route.displayOnly ? '' : 'connected');
	} catch (err) {
		updateStatus(`Load error: ${err.message}`, 'error');
	}
}

// /embed/:id (embedExport.js): the app in display-only mode for an <iframe>
// on another site: orbit camera, optional Enter VR (?vr=0 hides it), a
// "Made with GS For Anything" link, no editor UI and no Community list fetch.
async function bootEmbedScene(route) {
	embedRoute = route.embed;
	applyDisplayOnlyMode();
	document.body.classList.add('gs-embed');
	document.body.classList.toggle('gs-embed-vr', !!embedRoute.vr);
	if (embedRoute.vr && xrEntryButton) {
		xrEntryButton.style.display = '';
		// Since 0.990 the dock lives in the editor window's top bar, which an
		// embed hides; float it on the page instead (CSS: body.gs-embed #gs-dock).
		if (gsDock && gsDock.parentElement !== document.body) document.body.appendChild(gsDock);
		// Only an Enter VR button: no "VR not supported" notice on a page that isn't ours.
		const xr = navigator.xr;
		Promise.resolve(xr ? xr.isSessionSupported('immersive-vr') : false).catch(() => false)
			.then((supported) => { if (!supported) document.body.classList.remove('gs-embed-vr'); });
	}
	const chrome = mountEmbedChrome({ sceneId: route.sceneId });
	setCameraControlMode('orbit', { persist: false });
	try {
		const sc = await loadCommunitySceneById(route.sceneId, { activate: true });
		document.title = sc.name ? `${sc.name} — GS For Anything` : 'GS For Anything';
		chrome.setSceneName(sc.name);
		updateStatus('', '');
		document.body.dataset.gsEmbedReady = '1';
	} catch (err) {
		chrome.showMessage(err.exportsDisabled
			? 'The creator of this scene turned off exports, so it can\'t be embedded.'
			: err.status === 404 ? 'This scene doesn\'t exist or was removed.' : `This scene couldn't be loaded: ${err.message}`);
		document.body.dataset.gsEmbedReady = 'error';
	}
}

if (shareDisplayOnly) {
	shareDisplayOnly.addEventListener('change', () => {
		if (shareUrlInput) shareUrlInput.value = currentShareUrl();
	});
}
if (shareCloseBtn) shareCloseBtn.addEventListener('click', hideShareModal);
if (shareCopyBtn) {
	shareCopyBtn.addEventListener('click', async () => {
		const url = currentShareUrl();
		const ok = await copyText(url);
		shareCopyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
		setTimeout(() => { if (shareCopyBtn) shareCopyBtn.textContent = 'Copy link'; }, 1500);
	});
}
if (shareModal) shareModal.addEventListener('click', (e) => { if (e.target === shareModal) hideShareModal(); });
if (renameCancelBtn) renameCancelBtn.addEventListener('click', hideRenameModal);
if (renameConfirmBtn) renameConfirmBtn.addEventListener('click', renameCommunityScene);
if (renameNameInput) {
	renameNameInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); renameCommunityScene(); }
	});
}
if (renameModal) renameModal.addEventListener('click', (e) => { if (e.target === renameModal) hideRenameModal(); });


exportScreenshotBtn.addEventListener('click', () => {
	pendingExportThumbnail = captureScreenshot();
	exportPreview.innerHTML = `<img src="${pendingExportThumbnail}" style="width:80px;height:80px;border-radius:8px;object-fit:cover;">`;
});
exportCancelBtn.addEventListener('click', hideExportModal);
exportConfirmBtn.addEventListener('click', doExport);
exportDownloadBtn.addEventListener('click', doDownloadExport);

// The Scenes tab's current-scene card: thumbnail, name and how many blocks
// it has (its own code + what chat added). There is only ever one scene.
function renderDomSceneList() {
	if (!dchatCurrentScene) return;
	dchatCurrentScene.innerHTML = '';
	const sc = activeScene;
	const total = (sc?.codeBlocks?.length || 0) + executedCodeBlocks.length;
	if (!sc && total === 0) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'Empty scene. Chat to build one, or use Import .vrscene.json or Community. Loading a scene replaces this one.';
		dchatCurrentScene.appendChild(empty);
		return;
	}
	const item = document.createElement('div');
	item.className = 'dchat-scene-item active';

	const thumb = document.createElement('img');
	thumb.className = 'dchat-scene-thumb';
	if (sc?.thumbnail) thumb.src = sc.thumbnail;

	const info = document.createElement('div');
	info.className = 'dchat-scene-info';
	const name = document.createElement('div');
	name.className = 'dchat-scene-name';
	name.textContent = sc?.name || 'Untitled scene';
	name.title = name.textContent;
	const meta = document.createElement('div');
	meta.className = 'dchat-scene-dates';
	meta.textContent = `Current scene · ${total} block${total === 1 ? '' : 's'}`;
	info.append(name, meta);

	item.append(thumb, info);
	dchatCurrentScene.appendChild(item);
}


// ============================================================================
// XR Controller Input & Raycasting
// ============================================================================
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

function createControllerRay() {
	const rayLength = 5;
	const points = [
		new THREE.Vector3(0, 0, 0),
		new THREE.Vector3(0, 0, -rayLength)
	];
	const geometry = new THREE.BufferGeometry().setFromPoints(points);

	// Gradient ray: bright at hand, fades out
	const colors = new Float32Array([
		0.4, 0.4, 1.0,  // start: soft blue-indigo
		0.0, 0.0, 0.0   // end: fades to nothing
	]);
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

	const material = new THREE.LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.6,
		blending: THREE.AdditiveBlending,
		depthWrite: false
	});

	return new THREE.Line(geometry, material);
}

// Small reticle dot at the end of the ray for aiming feedback
function createReticle() {
	const geometry = new THREE.RingGeometry(0.005, 0.012, 24);
	const material = new THREE.MeshBasicMaterial({
		color: 0xfacc15, // amber, matching the .gs-ray-hover ring on VR windows
		transparent: true,
		opacity: 0.95,
		side: THREE.DoubleSide,
		depthTest: false
	});
	const ring = new THREE.Mesh(geometry, material);
	ring.name = 'vrRayReticle';
	ring.visible = false;
	ring.renderOrder = MENU_RETICLE_RENDER_ORDER;
	scene.add(ring);
	// Cursor must paint after the panels (same layer, higher renderOrder) or
	// the depthTest:false panels would cover it.
	registerMenuRoot(ring, MENU_RETICLE_RENDER_ORDER);
	return ring;
}

const controllerRays = [];
const reticles = [];

function setupXRControllers() {
	for (let i = 0; i < 2; i++) {
		const controller = renderer.xr.getController(i);
		controller.addEventListener('selectstart', onXRSelectStart);
		controller.addEventListener('selectstart', gsCamPipeline.kick); // retry a refused camera video play() on a trigger pull
		controller.addEventListener('selectend', onXRSelectEnd);
		controller.addEventListener('connected', (e) => { controller.userData.handedness = e.data && e.data.handedness; });
		controller.addEventListener('disconnected', () => { controller.userData.handedness = null; });

		// Attach ray line to controller
		const ray = createControllerRay();
		controller.add(ray);
		controllerRays.push(ray);

		// Create a reticle for hit feedback
		reticles.push(createReticle());

		// Controllers ride under viewOffset with the camera; player owns
		// locomotion yaw/move.
		viewOffset.add(controller);
	}
}

// The VR "Lay down" view was removed. Its state only ever lived in memory, but
// clear anything an older build or a test may have stored under a lay-down key
// and make sure the view rig is upright, so every session loads in the normal
// (sitting/standing) view.
function migrateLayDownState() {
	try {
		const stale = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && /lay[\s_.-]?down/i.test(key)) stale.push(key);
		}
		for (const key of stale) localStorage.removeItem(key);
	} catch { /* storage blocked */ }
	if (viewOffset) viewOffset.rotation.set(0, 0, 0);
}

function xrControllerIndex(controller) {
	for (let i = 0; i < 2; i++) {
		if (renderer.xr.getController(i) === controller) return i;
	}
	return -1;
}

// Trigger released: finish a canvas-surface press, or a VR window drag (a
// press that did not move clicks where it started, see vrWindows.js).
function onXRSelectEnd(event) {
	const idx = xrControllerIndex(event.target);
	if (idx >= 0 && _surfacePressed[idx]) {
		const surface = _surfacePressed[idx];
		_surfacePressed[idx] = null;
		const hover = _surfaceHover[idx];
		if (hover && hover.surface === surface) dispatchSurfacePointer(surface, hover.uv, 'up', { pointerId: 10 + idx });
		else dispatchSurfacePointer(surface, { x: 0.5, y: 0.5 }, 'cancel', { pointerId: 10 + idx });
		return;
	}
	if (idx >= 0 && vrWindows) for (const w of vrWindows.windows) w.endDrag(idx);
}

// Trigger pressed: a canvas surface the frame loop found in front of any
// window, else the VR window under the ray. On a scroller it starts a drag;
// anything else is clicked like a mouse click on the real element.
function onXRSelectStart(event) {
	const controller = event.target;
	const idx = xrControllerIndex(controller);
	if (idx >= 0 && _surfaceHover[idx]) {
		const { surface, uv } = _surfaceHover[idx];
		_surfacePressed[idx] = surface;
		dispatchSurfacePointer(surface, uv, 'down', { pointerId: 10 + idx, pressed: true });
		return;
	}
	if (!vrWindows) return;

	tempMatrix.identity().extractRotation(controller.matrixWorld);
	raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
	const hits = raycaster.intersectObjects(visibleVrWindowMeshes(_selectTargets), false);
	const hit = hits.find((h) => h.uv);
	if (!hit) return;
	const win = vrWindows.byMesh(hit.object);
	if (!win) return;
	if (idx >= 0 && win.beginDrag(idx, hit.uv)) return;
	win.click(hit.uv);
}
const _selectTargets = [];

// Meshes of the VR windows that are actually on screen (Raycaster does not
// check visibility, and the HUD's parent group is hidden outside XR).
function visibleVrWindowMeshes(out) {
	out.length = 0;
	if (!vrWindows) return out;
	// An open in-app dialog is modal: only it (and the keyboard) take the ray.
	const modal = vrDialogWindow && vrDialogWindow.visible;
	for (const w of vrWindows.windows) {
		if (modal && w !== vrDialogWindow && w !== vrKeyboardWindow) continue;
		let shown = true;
		for (let o = w.mesh; o; o = o.parent) {
			if (!o.visible) { shown = false; break; }
		}
		if (shown) out.push(w.mesh);
	}
	return out;
}

setupXRControllers();

// ============================================================================
// VR Code Execution Engine
// ============================================================================

/**
 * Parse Claude's response to extract vr-exec code blocks.
 * Returns display text (with code blocks replaced by markers) and the code blocks.
 */
function parseVrExecBlocks(text) {
	const codeBlocks = [];
	const displayText = text.replace(/```vr-exec\n([\s\S]*?)```/g, (match, code) => {
		codeBlocks.push(code.trim());
		return `[Executed code block ${codeBlocks.length}]`;
	});
	return { displayText: displayText.trim(), codeBlocks };
}

/**
 * Execute a code string with access to scene globals.
 * Runs as an AsyncFunction so vr-exec blocks can use top-level await.
 * Returns a Promise that resolves once the code finishes.
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ----------------------------------------------------------------------------
// Per-block runtime tracking (powers state-preserving hot reload)
// ----------------------------------------------------------------------------
// Every block runs with a key ("block:3", "scene:<id>#0", ...) and a `gs`
// helper. While it runs we record what it creates: top-level scene objects,
// _vrAnimations callbacks, timers, rAFs, listeners, overlay elements and
// canvas/p5 surfaces. Hot reload can then tear down and re-run ONE block,
// carrying over runtime state:
//   gs.state            per-block object that survives hot reloads
//   window.gsState      shared object that survives hot reloads
//   gs.onUpdate(fn)     per-frame callback, replaced (not stacked) on reload
//   gs.on(target, type, fn, opts) / gs.onDispose(fn)  cleaned up on reload
//   gs.hot              true when this run is a hot reload
// Bare setTimeout / setInterval / requestAnimationFrame (and their clear/cancel
// functions) inside a block are block-scoped wrappers, so old timers stop.
// Full reset (clearUserObjects) wipes all of it, state included.
const BLOCK_PARAMS = ['THREE', 'scene', 'camera', 'renderer', 'document', 'hud', 'gs'];
const BLOCK_TIMER_PARAMS = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'];
const BLOCK_ATTRIBUTION_WAIT_MS = 5000;
const _blockRuntimes = new Map();   // key -> runtime of the live run
const _blockStates = new Map();     // key -> gs.state (survives hot reload)
let _adhocBlockSeq = 0;
let _blockQueue = Promise.resolve();
window.gsState = window.gsState || {};

/** Compile a block without running it. Throws SyntaxError for bad code. */
function compileVrBlock(code) {
	try {
		return { fn: new AsyncFunction(...BLOCK_PARAMS, ...BLOCK_TIMER_PARAMS, code), timers: true };
	} catch (err) {
		// The block may declare its own `const setTimeout` etc.; fall back to
		// plain globals for timers rather than refuse the block.
		const fn = new AsyncFunction(...BLOCK_PARAMS, code); // rethrows real syntax errors
		return { fn, timers: false };
	}
}

function liveUserRoots() {
	return userContentRoots();
}

function newBlockRuntime(key, code) {
	return {
		key, code, roots: [], anims: [], timeouts: new Set(), intervals: new Set(), rafs: new Set(),
		listeners: [], disposers: [], overlay: [], surfaces: [], spawn: new Map()
	};
}

function makeBlockApi(rt, hot) {
	if (!_blockStates.has(rt.key)) _blockStates.set(rt.key, {});
	const timers = {
		setTimeout(fn, ms, ...args) {
			const id = window.setTimeout(() => { rt.timeouts.delete(id); if (typeof fn === 'function') fn(...args); }, ms);
			rt.timeouts.add(id);
			return id;
		},
		setInterval(fn, ms, ...args) {
			const id = window.setInterval(fn, ms, ...args);
			rt.intervals.add(id);
			return id;
		},
		clearTimeout(id) { rt.timeouts.delete(id); window.clearTimeout(id); },
		clearInterval(id) { rt.intervals.delete(id); window.clearInterval(id); },
		requestAnimationFrame(fn) {
			const id = window.requestAnimationFrame((t) => { rt.rafs.delete(id); fn(t); });
			rt.rafs.add(id);
			return id;
		},
		cancelAnimationFrame(id) { rt.rafs.delete(id); window.cancelAnimationFrame(id); }
	};
	const gs = {
		key: rt.key,
		hot: !!hot,
		state: _blockStates.get(rt.key),
		onUpdate(fn) {
			if (typeof fn !== 'function') return fn;
			window._vrAnimations.push(fn);
			return fn;
		},
		on(target, type, fn, opts) {
			if (!target || typeof target.addEventListener !== 'function') return;
			target.addEventListener(type, fn, opts);
			rt.listeners.push([target, type, fn, opts]);
		},
		onDispose(fn) { if (typeof fn === 'function') rt.disposers.push(fn); },
		...timers
	};
	return { gs, timers };
}

function snapshotTransformKeyed(rt, visit) {
	const seen = new Map();
	rt.roots.forEach((root, i) => {
		root.traverse((obj) => {
			let key;
			if (obj.name) key = 'n:' + obj.name;
			else if (obj === root) key = 'i:' + i;
			else return;
			const n = seen.get(key) || 0;
			seen.set(key, n + 1);
			if (n) key += '#' + n;
			visit(key, obj);
		});
	});
}

function recordBlockSpawn(rt) {
	rt.spawn.clear();
	snapshotTransformKeyed(rt, (key, obj) => {
		rt.spawn.set(key, {
			pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone(),
			vel: obj.userData && obj.userData.velocity && obj.userData.velocity.isVector3 ? obj.userData.velocity.clone() : null
		});
	});
}

function readAmmoVelocity(body) {
	try {
		const lv = body.getLinearVelocity(), av = body.getAngularVelocity();
		return { lin: [lv.x(), lv.y(), lv.z()], ang: [av.x(), av.y(), av.z()] };
	} catch { return null; }
}

/** Live transforms (and velocities) of everything a block created, keyed by
 *  object name (or root order for unnamed roots). */
function snapshotBlockState(rt) {
	const snap = new Map();
	snapshotTransformKeyed(rt, (key, obj) => {
		const body = obj.userData && obj.userData.physicsBody;
		snap.set(key, {
			pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone(),
			vel: obj.userData && obj.userData.velocity && obj.userData.velocity.isVector3 ? obj.userData.velocity.clone() : null,
			body: body ? readAmmoVelocity(body) : null,
			spawn: rt.spawn.get(key) || null
		});
	});
	return snap;
}

function syncAmmoBodyToObject(obj, vel) {
	const body = obj.userData && obj.userData.physicsBody;
	if (!body || typeof body.getWorldTransform !== 'function') return;
	try {
		obj.updateWorldMatrix(true, false);
		const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
		// Physics runs in the scene's own frame: relative to the origin root
		// when the object lives under it (rotated origin / Walk-in-AR).
		let inOrigin = false;
		for (let a = obj.parent; a; a = a.parent) if (a === gsOriginRoot) { inOrigin = true; break; }
		if (inOrigin) new THREE.Matrix4().copy(gsOriginRoot.matrixWorld).invert().multiply(obj.matrixWorld).decompose(p, q, sc);
		else obj.matrixWorld.decompose(p, q, sc);
		const t = body.getWorldTransform();
		t.getOrigin().setValue(p.x, p.y, p.z);
		const bq = t.getRotation();
		bq.setValue(q.x, q.y, q.z, q.w);
		t.setRotation(bq);
		const ms = body.getMotionState && body.getMotionState();
		if (ms && ms.setWorldTransform) ms.setWorldTransform(t);
		if (vel) {
			const lv = body.getLinearVelocity(); lv.setValue(vel.lin[0], vel.lin[1], vel.lin[2]); body.setLinearVelocity(lv);
			const av = body.getAngularVelocity(); av.setValue(vel.ang[0], vel.ang[1], vel.ang[2]); body.setAngularVelocity(av);
		}
		if (body.activate) body.activate();
	} catch (e) {
		console.warn('hot reload: could not re-sync physics body', e);
	}
}

/** Put runtime state back onto a block's new objects. A value is only carried
 *  over when the code's starting value is unchanged, so editing an object's
 *  start position in code still moves it. */
function restoreBlockState(snap, rt) {
	if (!snap || !snap.size) return 0;
	let restored = 0;
	snapshotTransformKeyed(rt, (key, obj) => {
		const old = snap.get(key);
		if (!old) return;
		const spawn = rt.spawn.get(key);
		const same = (a, b) => !!(a && b && a.equals(b));
		// Per axis, so editing only the start height keeps the runtime x/z.
		for (const axis of ['x', 'y', 'z']) {
			if (!old.spawn || !spawn || old.spawn.pos[axis] === spawn.pos[axis]) obj.position[axis] = old.pos[axis];
			if (!old.spawn || !spawn || old.spawn.scale[axis] === spawn.scale[axis]) obj.scale[axis] = old.scale[axis];
		}
		if (!old.spawn || !spawn || same(old.spawn.quat, spawn.quat)) obj.quaternion.copy(old.quat);
		const v = obj.userData && obj.userData.velocity;
		if (old.vel && v && v.isVector3 && (!old.spawn || !spawn || !old.spawn.vel || same(old.spawn.vel, spawn.vel))) v.copy(old.vel);
		syncAmmoBodyToObject(obj, old.body);
		restored++;
	});
	return restored;
}

/** Undo everything one block run created, leaving every other block alone. */
function teardownBlock(rt) {
	if (!rt) return;
	for (const fn of rt.disposers) { try { fn(); } catch (e) { console.warn('block dispose hook failed', e); } }
	for (const id of rt.timeouts) window.clearTimeout(id);
	for (const id of rt.intervals) window.clearInterval(id);
	for (const id of rt.rafs) window.cancelAnimationFrame(id);
	for (const [target, type, fn, opts] of rt.listeners) { try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ } }
	if (rt.anims.length) {
		const drop = new Set(rt.anims);
		window._vrAnimations = window._vrAnimations.filter((f) => !drop.has(f));
	}
	for (const surf of rt.surfaces) { try { surf.dispose(); } catch (e) { console.warn('surface dispose failed', e); } }
	const world = window.physicsWorld;
	for (const root of rt.roots) {
		root.traverse((obj) => {
			const body = obj.userData && obj.userData.physicsBody;
			if (body && world && typeof world.removeRigidBody === 'function') {
				try { world.removeRigidBody(body); } catch { /* ignore */ }
			}
		});
		if (root.parent) root.parent.remove(root);
		disposeRecursive(root);
	}
	for (const el of rt.overlay) el.remove();
	if (_blockRuntimes.get(rt.key) === rt) _blockRuntimes.delete(rt.key);
}

/** Run one block with tracking. Runs are serialized so objects are attributed
 *  to the right block. */
function runTrackedBlock(code, key, { hot = false, compiled = null } = {}) {
	const job = _blockQueue.then(() => runTrackedBlockNow(code, key, { hot, compiled }));
	_blockQueue = job.then(() => {}, () => {});
	return job;
}

async function runTrackedBlockNow(code, key, { hot, compiled }) {
	const { fn, timers: useTimers } = compiled || compileVrBlock(code);
	const rt = newBlockRuntime(key, code);
	const rootsBefore = new Set(liveUserRoots());
	const animsBefore = new Set(window._vrAnimations);
	const surfacesBefore = new Set(gsSurfaces);
	const overlayRoot = document.getElementById('overlay-root');
	const overlayBefore = new Set(overlayRoot ? overlayRoot.children : []);
	const { gs, timers } = makeBlockApi(rt, hot);
	const args = [THREE, scene, camera, renderer, document, hud, gs];
	if (useTimers) args.push(...BLOCK_TIMER_PARAMS.map((n) => timers[n]));
	const finish = () => {
		reanchorStrayObjects();
		rt.roots = liveUserRoots().filter((r) => !rootsBefore.has(r));
		rt.anims = window._vrAnimations.filter((f) => !animsBefore.has(f));
		rt.surfaces = [...gsSurfaces].filter((sf) => !surfacesBefore.has(sf));
		rt.overlay = overlayRoot ? [...overlayRoot.children].filter((el) => !overlayBefore.has(el) && !systemOverlayIds.has(el.id)) : [];
		recordBlockSpawn(rt);
		_blockRuntimes.set(key, rt);
	};
	let run;
	try {
		run = Promise.resolve(fn(...args));
	} catch (err) {
		finish();
		throw err;
	}
	// A block that keeps awaiting (big model download) shouldn't hold up the
	// rest; attribute what it made so far and let it finish in the background.
	let timer = 0;
	const capped = new Promise((resolve) => { timer = window.setTimeout(() => resolve('timeout'), BLOCK_ATTRIBUTION_WAIT_MS); });
	try {
		const r = await Promise.race([run, capped]);
		if (r === 'timeout') run.finally(reanchorStrayObjects).catch(() => {});
	} finally {
		window.clearTimeout(timer);
		finish();
	}
	return rt;
}

/**
 * Run a vr-exec block. `key` identifies it for hot reload (session blocks are
 * "block:<index>", scene blocks "scene:<id>#<index>"); omit for one-off runs.
 */
function executeVrCode(code, key) {
	return runTrackedBlock(code, key || `adhoc:${++_adhocBlockSeq}`);
}

// Safety net: an object that ends up parented to the camera or to a UI panel
// would move/rotate with the user's view or the chat window. After each block we
// move any such stray back into the world, preserving its current world transform
// so it stays put in the room. Objects the model was *directed* to make
// head-locked go under `hud` (a child of the camera) and are left alone.
function reanchorStrayObjects() {
	const worldParent = getWorldContentParent();
	// Camera: strays follow the head; the intentional `hud` group is exempt.
	for (let i = camera.children.length - 1; i >= 0; i--) {
		const child = camera.children[i];
		if (child === hud) continue;
		worldParent.attach(child); // keep world transform; AR uses placement root
	}
	// VR windows never legitimately have child meshes, so anything parented to
	// one is a stray object that would ride along with the window — re-anchor it.
	if (vrWindows) {
		for (const w of vrWindows.windows) {
			for (let i = w.mesh.children.length - 1; i >= 0; i--) {
				worldParent.attach(w.mesh.children[i]);
			}
		}
	}
	// A rotated origin takes new scene-root content (in scene coordinates).
	if (originRotationActive()) adoptSceneContentIntoOrigin();
	// While Walk-in-AR is active, also pull newly added scene-root content into
	// the draggable placement group so chat-generated objects stay with the scene.
	if (mobileXRMode === 'ar') adoptSceneContentIntoArPlacement();
}

const MAX_FIX_ATTEMPTS = 3;

/**
 * Attempt to fix a failing code block via the error-correction API.
 * Returns { success, code, error } — the final fixed code if successful.
 */
async function attemptAutoFix(failingCode, errorMessage, errorStack, blockKey) {
	const priorFixes = [];

	for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
		updateStatus(`Fixing code (attempt ${attempt}/${MAX_FIX_ATTEMPTS})...`, '');
		renderDomChat();

		const thisFailingCode = attempt === 1 ? failingCode : priorFixes[priorFixes.length - 1].code;

		try {
			let data;
			if (selectedBackend === 'ollama') {
				// Built to match the server's /api/fix-code prompt exactly (see
				// server.js) - kept client-side too so no code/error content has
				// to transit the server just to reach the user's own local model.
				let userContent = `The following vr-exec code block failed to execute.\n\n`;
				userContent += `**Error:** \`${errorMessage}\`\n`;
				if (errorStack) userContent += `**Stack:** \`${errorStack}\`\n`;
				userContent += `**Attempt:** ${attempt} of ${MAX_FIX_ATTEMPTS}\n\n`;
				userContent += `**Failing code:**\n\`\`\`javascript\n${thisFailingCode}\n\`\`\`\n\n`;
				if (priorFixes.length > 0) {
					userContent += `**Previous fix attempts that also failed:**\n`;
					for (const fix of priorFixes) {
						userContent += `\nAttempt ${fix.attempt} error: \`${fix.error}\`\n`;
						userContent += `\`\`\`javascript\n${fix.code}\n\`\`\`\n`;
					}
					userContent += `\nThe prior fixes did not work. Try a different approach.\n`;
				}
				userContent += `\nFix this code. Return ONLY a single \`vr-exec\` code block.`;
				userContent += `\n\n${buildGsSettingsNote()}`;

				data = await callOllamaDirect(
					cachedPrompts?.fixCodePrompt || '',
					[{ role: 'user', content: userContent }],
					selectedOllamaModel,
					8192
				);
			} else {
				const response = await fetch('/api/fix-code', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						failingCode: thisFailingCode,
						errorMessage,
						errorStack,
						attempt,
						priorFixes,
						sceneContext: buildGsSettingsNote(),
						backend: selectedBackend
					})
				});

				const responseText = await response.text();
				try {
					data = JSON.parse(responseText);
				} catch (e) {
					throw new Error(`Fix API returned non-JSON: ${responseText.slice(0, 120)}`);
				}

				if (!response.ok) {
					throw new Error(data.error || `Fix API error: ${response.status}`);
				}
			}

			const fixedRaw = data.content[0]?.text || '';
			const { codeBlocks: fixedBlocks } = parseVrExecBlocks(fixedRaw);

			if (fixedBlocks.length === 0) {
				// The response didn't contain a vr-exec block — try extracting from plain code fences
				const plainMatch = fixedRaw.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
				if (plainMatch) {
					fixedBlocks.push(plainMatch[1].trim());
				}
			}

			if (fixedBlocks.length === 0) {
				throw new Error('Fix response contained no code block');
			}

			const fixedCode = fixedBlocks[0];

			// Try executing the fixed code
			try {
				await executeVrCode(fixedCode, blockKey);
				return { success: true, code: fixedCode, attempts: attempt };
			} catch (retryErr) {
				// This fix also failed — record it and try again
				errorMessage = retryErr.message;
				errorStack = retryErr.stack;
				priorFixes.push({ attempt, code: fixedCode, error: retryErr.message });
			}

		} catch (apiErr) {
			console.error(`Fix attempt ${attempt} API error:`, apiErr);
			return { success: false, code: null, error: apiErr.message, attempts: attempt };
		}
	}

	return {
		success: false,
		code: null,
		error: `Failed after ${MAX_FIX_ATTEMPTS} fix attempts. Last error: ${errorMessage}`,
		attempts: MAX_FIX_ATTEMPTS
	};
}

// ============================================================================
// Chat attachments (desktop only - images and text-ish files for context)
// ============================================================================
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024; // 6MB raw per file
const MAX_ATTACHMENTS = 4;
const TEXTY_FILE_EXT = /\.(txt|md|markdown|json|js|jsx|ts|tsx|py|csv|html|htm|css|xml|yaml|yml|log|c|cpp|h|hpp|java|go|rs|sh|sql|ini|toml)$/i;

function isTextyFile(file) {
	return file.type.startsWith('text/') || file.type === 'application/json' || TEXTY_FILE_EXT.test(file.name);
}

function readFileAsDataURL(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error || new Error('Read failed'));
		reader.readAsDataURL(file);
	});
}

function readFileAsText(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error || new Error('Read failed'));
		reader.readAsText(file);
	});
}

async function addAttachments(fileList) {
	for (const file of fileList) {
		if (pendingAttachments.length >= MAX_ATTACHMENTS) {
			updateStatus(`Only ${MAX_ATTACHMENTS} attachments at a time`, 'error');
			break;
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			updateStatus(`"${file.name}" is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)`, 'error');
			continue;
		}
		try {
			if (file.type.startsWith('image/')) {
				const dataUrl = await readFileAsDataURL(file);
				const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
				pendingAttachments.push({
					id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
					name: file.name,
					kind: 'image',
					mediaType: file.type,
					base64
				});
			} else if (isTextyFile(file)) {
				const text = await readFileAsText(file);
				pendingAttachments.push({
					id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
					name: file.name,
					kind: 'text',
					text
				});
			} else {
				updateStatus(`"${file.name}" isn't a supported type — images and text files only`, 'error');
			}
		} catch (err) {
			updateStatus(`Couldn't read "${file.name}": ${err.message}`, 'error');
		}
	}
	renderAttachmentChips();
}

function renderAttachmentChips() {
	if (!desktopAttachmentsRow) return;
	desktopAttachmentsRow.innerHTML = '';
	desktopAttachmentsRow.hidden = pendingAttachments.length === 0;
	for (const att of pendingAttachments) {
		const chip = document.createElement('div');
		chip.className = 'dchat-attachment-chip';

		const icon = document.createElement('span');
		icon.textContent = att.kind === 'image' ? '🖼️' : '📄';

		const name = document.createElement('span');
		name.className = 'dchat-attachment-name';
		name.textContent = att.name;
		name.title = att.name;

		const remove = document.createElement('button');
		remove.className = 'dchat-attachment-remove';
		remove.textContent = '×';
		remove.title = 'Remove';
		remove.addEventListener('click', () => {
			pendingAttachments = pendingAttachments.filter(a => a.id !== att.id);
			renderAttachmentChips();
		});

		chip.append(icon, name, remove);
		desktopAttachmentsRow.appendChild(chip);
	}
}

// ============================================================================
// Context Files library (Files tab) — persisted in IndexedDB, pickable from chat
// ============================================================================
const FILES_DB_NAME = 'carljr-context-files';
const FILES_STORE = 'files';
const MAX_LIBRARY_FILES = 40;

function formatFileSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openFilesDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(FILES_DB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(FILES_STORE)) {
				db.createObjectStore(FILES_STORE, { keyPath: 'id' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
	});
}

async function idbGetAllFiles() {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readonly');
		const req = tx.objectStore(FILES_STORE).getAll();
		req.onsuccess = () => resolve(req.result || []);
		req.onerror = () => reject(req.error);
	});
}

async function idbPutFile(record) {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		tx.objectStore(FILES_STORE).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function idbDeleteFile(id) {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		tx.objectStore(FILES_STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function idbClearFiles() {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		tx.objectStore(FILES_STORE).clear();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function loadContextLibrary() {
	try {
		contextLibrary = await idbGetAllFiles();
		contextLibrary.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
	} catch (err) {
		console.warn('Context library load failed', err);
		contextLibrary = [];
	}
	renderContextFilesList();
}

function libraryRecordFromPendingShape(rec) {
	// pendingAttachments / library share { id, name, kind, ... }
	return {
		id: rec.id,
		name: rec.name,
		kind: rec.kind,
		mediaType: rec.mediaType || '',
		base64: rec.base64 || '',
		text: rec.text || '',
		size: rec.size || 0,
		addedAt: rec.addedAt || Date.now()
	};
}

function attachmentFromLibrary(rec) {
	const out = {
		id: rec.id + '-' + Math.random().toString(36).slice(2, 6),
		name: rec.name,
		kind: rec.kind,
		libraryId: rec.id
	};
	if (rec.kind === 'image') {
		out.mediaType = rec.mediaType;
		out.base64 = rec.base64;
	} else {
		out.text = rec.text;
	}
	return out;
}

async function addFilesToLibrary(fileList) {
	for (const file of fileList) {
		if (contextLibrary.length >= MAX_LIBRARY_FILES) {
			updateStatus(`Library full (max ${MAX_LIBRARY_FILES} files)`, 'error');
			break;
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			updateStatus(`"${file.name}" is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)`, 'error');
			continue;
		}
		try {
			let record;
			const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			if (file.type.startsWith('image/')) {
				const dataUrl = await readFileAsDataURL(file);
				const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
				record = {
					id, name: file.name, kind: 'image', mediaType: file.type,
					base64, text: '', size: file.size, addedAt: Date.now()
				};
			} else if (isTextyFile(file)) {
				const text = await readFileAsText(file);
				record = {
					id, name: file.name, kind: 'text', mediaType: file.type || 'text/plain',
					base64: '', text, size: file.size, addedAt: Date.now()
				};
			} else {
				updateStatus(`"${file.name}" isn't a supported type — images and text files only`, 'error');
				continue;
			}
			await idbPutFile(record);
			contextLibrary.unshift(record);
			updateStatus(`Added "${file.name}" to Files`, 'connected');
		} catch (err) {
			updateStatus(`Couldn't save "${file.name}": ${err.message}`, 'error');
		}
	}
	renderContextFilesList();
}

async function removeLibraryFile(id) {
	try {
		await idbDeleteFile(id);
	} catch (err) {
		updateStatus(`Couldn't remove file: ${err.message}`, 'error');
		return;
	}
	contextLibrary = contextLibrary.filter(f => f.id !== id);
	renderContextFilesList();
}

async function clearContextLibrary() {
	if (!contextLibrary.length) return;
	if (!await gsConfirm(`Remove all ${contextLibrary.length} files from the library?`, { title: 'Clear Files library', okLabel: 'Remove all', danger: true })) return;
	try {
		await idbClearFiles();
		contextLibrary = [];
		renderContextFilesList();
		updateStatus('Files library cleared', 'connected');
	} catch (err) {
		updateStatus(`Clear failed: ${err.message}`, 'error');
	}
}

function renderContextFilesList() {
	if (scenePanelSubTab === 'files') renderDomSceneList();
	if (!dchatFilesList) return;
	dchatFilesList.innerHTML = '';
	if (!contextLibrary.length) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No files yet. Upload images or text to use as chat context.';
		dchatFilesList.appendChild(empty);
		return;
	}
	for (const rec of contextLibrary) {
		const item = document.createElement('div');
		item.className = 'dchat-file-item';

		const icon = document.createElement('span');
		icon.textContent = rec.kind === 'image' ? '🖼️' : '📄';

		const meta = document.createElement('div');
		meta.className = 'meta';
		const name = document.createElement('div');
		name.className = 'name';
		name.textContent = rec.name;
		name.title = rec.name;
		const sub = document.createElement('div');
		sub.className = 'sub';
		sub.textContent = `${rec.kind === 'image' ? 'Image' : 'Text'} · ${formatFileSize(rec.size || 0)}`;
		meta.append(name, sub);

		const remove = document.createElement('button');
		remove.className = 'dchat-btn';
		remove.textContent = 'Remove';
		remove.addEventListener('click', () => removeLibraryFile(rec.id));

		item.append(icon, meta, remove);
		dchatFilesList.appendChild(item);
	}
}

function renderThemeAttachmentChips() {
	if (!dchatThemeAttachmentsRow) return;
	dchatThemeAttachmentsRow.innerHTML = '';
	dchatThemeAttachmentsRow.hidden = pendingThemeAttachments.length === 0;
	for (const att of pendingThemeAttachments) {
		const chip = document.createElement('div');
		chip.className = 'dchat-attachment-chip';
		const icon = document.createElement('span');
		icon.textContent = att.kind === 'image' ? '🖼️' : '📄';
		const name = document.createElement('span');
		name.className = 'dchat-attachment-name';
		name.textContent = att.name;
		name.title = att.name;
		const remove = document.createElement('button');
		remove.className = 'dchat-attachment-remove';
		remove.textContent = '×';
		remove.title = 'Remove';
		remove.addEventListener('click', () => {
			pendingThemeAttachments = pendingThemeAttachments.filter(a => a.id !== att.id);
			renderThemeAttachmentChips();
		});
		chip.append(icon, name, remove);
		dchatThemeAttachmentsRow.appendChild(chip);
	}
}

function openFilesPicker(target) {
	filesPickerTarget = target === 'theme' ? 'theme' : 'scene';
	filesPickerSelected = new Set();
	if (!filesPickerModal || !filesPickerList) return;
	filesPickerList.innerHTML = '';
	if (!contextLibrary.length) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.style.padding = '12px';
		empty.textContent = 'No files in the library yet. Open the Files tab to upload some.';
		filesPickerList.appendChild(empty);
	} else {
		for (const rec of contextLibrary) {
			const row = document.createElement('label');
			row.className = 'files-picker-row';
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.value = rec.id;
			cb.addEventListener('change', () => {
				if (cb.checked) filesPickerSelected.add(rec.id);
				else filesPickerSelected.delete(rec.id);
				row.classList.toggle('selected', cb.checked);
			});
			const label = document.createElement('div');
			label.className = 'label';
			const name = document.createElement('div');
			name.className = 'name';
			name.textContent = `${rec.kind === 'image' ? '🖼️' : '📄'} ${rec.name}`;
			const sub = document.createElement('div');
			sub.className = 'sub';
			sub.textContent = `${rec.kind === 'image' ? 'Image' : 'Text'} · ${formatFileSize(rec.size || 0)}`;
			label.append(name, sub);
			row.append(cb, label);
			filesPickerList.appendChild(row);
		}
	}
	filesPickerModal.classList.add('open');
	filesPickerModal.setAttribute('aria-hidden', 'false');
}

function closeFilesPicker() {
	if (!filesPickerModal) return;
	filesPickerModal.classList.remove('open');
	filesPickerModal.setAttribute('aria-hidden', 'true');
	filesPickerSelected = new Set();
}

function confirmFilesPicker() {
	const picked = contextLibrary.filter(f => filesPickerSelected.has(f.id));
	if (!picked.length) {
		closeFilesPicker();
		return;
	}
	if (filesPickerTarget === 'theme') {
		for (const rec of picked) {
			if (pendingThemeAttachments.length >= MAX_ATTACHMENTS) {
				updateStatus(`Only ${MAX_ATTACHMENTS} attachments at a time`, 'error');
				break;
			}
			// Theme API is text-only; skip images with a note
			if (rec.kind === 'image') {
				updateStatus(`Theme chat uses text files only — skipped "${rec.name}"`, 'error');
				continue;
			}
			if (pendingThemeAttachments.some(a => a.libraryId === rec.id || a.name === rec.name)) continue;
			pendingThemeAttachments.push(attachmentFromLibrary(rec));
		}
		renderThemeAttachmentChips();
	} else {
		for (const rec of picked) {
			if (pendingAttachments.length >= MAX_ATTACHMENTS) {
				updateStatus(`Only ${MAX_ATTACHMENTS} attachments at a time`, 'error');
				break;
			}
			if (pendingAttachments.some(a => a.libraryId === rec.id || (a.name === rec.name && a.kind === rec.kind))) continue;
			pendingAttachments.push(attachmentFromLibrary(rec));
		}
		renderAttachmentChips();
	}
	closeFilesPicker();
	updateStatus(`Added ${picked.length} file(s) to prompt`, 'connected');
}

// Shapes attached files into whatever the selected backend expects. Text
// files fold directly into the plain-text message (works identically for
// every backend); images need a backend-specific content shape, since
// Anthropic, OpenAI, and Ollama each represent an inline image differently.
function buildUserContent(userMessage, attachments, backend) {
	let text = userMessage;
	for (const att of attachments.filter(a => a.kind === 'text')) {
		text += `\n\n--- File: ${att.name} ---\n${att.text}`;
	}

	const images = attachments.filter(a => a.kind === 'image');
	if (images.length === 0) return { content: text };

	const provider = backendProvider(backend);
	if (provider === 'ollama') {
		// Ollama's /api/chat takes images as a separate per-message field
		// (raw base64, no "data:" prefix), not inline in content.
		return { content: text || '(see attached image)', images: images.map(a => a.base64) };
	}

	if (provider === 'openai') {
		const parts = [{ type: 'text', text: text || '(see attached image)' }];
		for (const att of images) {
			parts.push({ type: 'image_url', image_url: { url: `data:${att.mediaType};base64,${att.base64}` } });
		}
		return { content: parts };
	}

	// Claude models (Anthropic content-block shape)
	const parts = [{ type: 'text', text: text || '(see attached image)' }];
	for (const att of images) {
		parts.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.base64 } });
	}
	return { content: parts };
}

// ============================================================================
// Claude API Integration (via proxy server)
// ============================================================================
async function sendMessage(userMessage) {
	if (!userMessage.trim() && pendingAttachments.length === 0) return;

	// Fold attachments into this message, then clear the staging area - see
	// buildUserContent() for how each attachment kind/backend is shaped.
	const attachments = pendingAttachments;
	pendingAttachments = [];
	renderAttachmentChips();

	const { content: userContent, images: ollamaImages } = buildUserContent(userMessage, attachments, selectedBackend);
	const turnBackend = selectedBackend;
	const turnModel = getActiveModelDisplayName();
	// A reply that lands after another scene was loaded belongs to the old
	// scene's chat: drop it instead of adding it (and its code) to this one.
	const turnEpoch = sceneEpoch;
	GSContext.recordUserTurn({ text: userMessage, attachments, backend: turnBackend, model: turnModel });

	// Add user message to both arrays
	messages.push({ role: 'user', content: userContent, ...(ollamaImages ? { images: ollamaImages } : {}) });
	displayMessages.push({
		role: 'user',
		content: userMessage + (attachments.length > 0 ? `\n\n📎 ${attachments.map(a => a.name).join(', ')}` : '')
	});

	// Set loading state BEFORE rendering so the model-aware thinking indicator
	// is drawn immediately — otherwise it only appears on the next render (which
	// previously required a click/interaction to trigger).
	isLoading = true;
	sendButton.disabled = true;
	updateStatus('Sending...', '');
	renderDomChat();

	try {
		let data;
		if (selectedBackend === 'ollama') {
			data = await callOllamaDirect(
				ChatPrompt.effectivePrompt() || cachedPrompts?.systemPrompt || '',
				withGsSettingsNote(messages.map(m => ({ role: m.role, content: m.content, ...(m.images ? { images: m.images } : {}) }))),
				selectedOllamaModel
			);
		} else {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					// The editor settings note (Environment 2D/3D, Dependencies,
					// gamepad helper) rides on the newest user message only.
					messages: withGsSettingsNote(messages.map(m => ({
						role: m.role,
						content: m.content
					}))),
					backend: selectedBackend,
					// Custom Scene chat prompt from Chat → Prompt (omitted = default).
					...ChatPrompt.requestFields()
				})
			});

			// Read as text first to avoid opaque JSON parse errors
			const responseText = await response.text();
			try {
				data = JSON.parse(responseText);
			} catch (parseErr) {
				throw new Error(`Server returned non-JSON (${response.status}): ${responseText.slice(0, 120)}`);
			}

			if (!response.ok) {
				throw new Error(data.error || `API error: ${response.status}`);
			}
		}
		if (turnEpoch !== sceneEpoch) return;
		const rawText = data.content[0]?.text || 'No response';

		// Parse and execute any vr-exec code blocks
		const { displayText, codeBlocks } = parseVrExecBlocks(rawText);

		// Store raw text for API context, cleaned text for display
		messages.push({ role: 'assistant', content: rawText });
		displayMessages.push({ role: 'assistant', content: displayText });
		GSContext.recordAssistantTurn({ raw: rawText, display: displayText, backend: turnBackend, model: turnModel, codeBlockCount: codeBlocks.length });

		if (codeBlocks.length > 0) {
			let execCount = 0;
			let fixCount = 0;
			for (const code of codeBlocks) {
				if (turnEpoch !== sceneEpoch) return;
				const blockKey = sessionBlockKey(executedCodeBlocks.length);
				try {
					await executeVrCode(code, blockKey);
					executedCodeBlocks.push(code);
					execCount++;
				} catch (execErr) {
					console.error('vr-exec error:', execErr);
					displayMessages.push({
						role: 'assistant',
						content: `[Code error: ${execErr.message} — auto-fixing...]`
					});
					renderDomChat();

					// Attempt auto-fix
					const fix = await attemptAutoFix(code, execErr.message, execErr.stack, blockKey);
					if (turnEpoch !== sceneEpoch) return;
					if (fix.success) {
						executedCodeBlocks.push(fix.code);
						execCount++;
						fixCount++;
						displayMessages.push({
							role: 'assistant',
							content: `[Fixed after ${fix.attempts} attempt${fix.attempts > 1 ? 's' : ''}]`
						});
						GSContext.recordNote(`[Code error: ${execErr.message}. Auto-fixed after ${fix.attempts} attempt${fix.attempts > 1 ? 's' : ''}; fixed code:]\n${fix.code}`);
					} else {
						displayMessages.push({
							role: 'assistant',
							content: `[Auto-fix failed: ${fix.error}]`
						});
						GSContext.recordNote(`[Code error: ${execErr.message}. Auto-fix failed: ${fix.error}]`);
					}
				}
			}
			if (execCount > 0) {
				const fixNote = fixCount > 0 ? ` (${fixCount} auto-fixed)` : '';
				updateStatus(`Connected — ran ${execCount} block${execCount > 1 ? 's' : ''}${fixNote}`, 'connected');
				notifyCodeEditorExternalChange();
			} else {
				updateStatus('Connected', 'connected');
			}
		} else {
			updateStatus('Connected', 'connected');
		}

	} catch (error) {
		console.error('Chat error:', error);
		if (turnEpoch !== sceneEpoch) return;
		updateStatus(`Error: ${error.message}`, 'error');
		const errMsg = `Error: ${error.message}`;
		messages.push({ role: 'assistant', content: errMsg });
		displayMessages.push({ role: 'assistant', content: errMsg });
		GSContext.recordAssistantTurn({ raw: errMsg, display: errMsg, backend: turnBackend, model: turnModel, error: true });
	} finally {
		isLoading = false;
		sendButton.disabled = false;
		renderDomChat();
	}
}

// Creation context (chat log + info log saved with scenes): see creationContext.js.
GSContext.initCreationContext({
	appVersion: GS_VERSION,
	getSettings: () => ({
		environment: { ...sceneEnv, lib: currentSceneLib() },
		dependencies: GS_DEPS ? GS_DEPS.list.map(d => ({ id: d.id, name: d.name, version: d.version, enabled: GS_DEPS.isEnabled(d.id) })) : [],
		backend: selectedBackend,
		model: getActiveModelDisplayName(),
		locomotion: locomotionMode
	}),
	getSettingsNote: () => buildGsSettingsNote(),
	getLibraryFiles: () => contextLibrary.map(f => ({ name: f.name, kind: f.kind, size: f.size || 0 })),
	getSceneName: () => activeScene?.name || 'Current session',
	// Restored history goes into both arrays: `messages` is what the next
	// /api/chat request sends, `displayMessages` is drawn on desktop and in VR.
	appendChatHistory: (apiMsgs, displayMsgs) => {
		if (apiMsgs.length) {
			const last = messages[messages.length - 1];
			if (last && last.role === 'user') messages.push({ role: 'assistant', content: '(Continuing below with the creation history of a loaded scene.)' });
			messages.push(...apiMsgs);
		}
		displayMessages.push(...displayMsgs);
		renderDomChat();
	},
	pushChatNote: (text) => {
		displayMessages.push({ role: 'assistant', content: text, history: true, historyMarker: true });
		renderDomChat();
	},
	updateStatus: (t, c) => updateStatus(t, c),
	isXrActive: () => xrSessionActive() || !!mobileXRMode,
	isDisplayOnly: () => displayOnlyMode
});
window.GSContext = GSContext; // console / test access

// Community scene merge (see communityMerge.js). The AI call uses the same
// backend path as the scene chat; the result is installed as a new scene.
async function callSceneChatBackend(apiMessages) {
	if (selectedBackend === 'ollama') {
		const data = await callOllamaDirect(ChatPrompt.effectivePrompt() || cachedPrompts?.systemPrompt || '', withGsSettingsNote(apiMessages), selectedOllamaModel);
		return data.content[0]?.text || '';
	}
	const response = await fetch('/api/chat', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ messages: withGsSettingsNote(apiMessages), backend: selectedBackend, ...ChatPrompt.requestFields() })
	});
	const text = await response.text();
	let data;
	try { data = JSON.parse(text); } catch { throw new Error(`Server returned non-JSON (${response.status}): ${text.slice(0, 120)}`); }
	if (!response.ok) throw new Error(data.error || `API error: ${response.status}`);
	return data.content?.[0]?.text || '';
}

GSMerge.initCommunityMerge({
	getCommunityScenes: () => communityScenesCache,
	getModelSelect: () => desktopModelSelect,
	getModelLabel: () => getActiveModelDisplayName(),
	loadContext: (data) => GSContext.loadContextForScene(data),
	isDisplayOnly: () => displayOnlyMode,
	// Merging copies a scene's code: only for scenes with exports allowed (or our own).
	canMergeScene: (cs) => cs?.allowExport !== false || !!ownerKeyFor(cs?.id),
	parseVrExecBlocks: (text) => parseVrExecBlocks(text),
	callChat: async (apiMessages) => {
		isLoading = true;
		renderDomChat();
		try { return await callSceneChatBackend(apiMessages); } finally { isLoading = false; renderDomChat(); }
	},
	// The merged scene replaces the active scene (and its chat); neither
	// original is touched. Failing blocks go through the normal auto-fix
	// (asset tokens keep base64 out of the fix call).
	installMergedScene: async ({ name, codeBlocks, mergedFrom, tokenize, expand }) => {
		const sc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name, thumbnail: '', codeBlocks: [], createdAt: new Date().toISOString(), mergedFrom };
		setActiveScene(sc);
		let fixed = 0, failed = 0;
		for (const code of codeBlocks) {
			// Run under the scene's block key (PR #3 hot reload): the Code tab
			// then knows each block and won't re-run unchanged ones.
			const blockKey = sceneBlockKey(sc, sc.codeBlocks.length);
			try {
				await executeVrCode(code, blockKey);
				sc.codeBlocks.push(code);
			} catch (err) {
				console.error('merged block error:', err);
				teardownBlock(_blockRuntimes.get(blockKey)); // drop what the failed run made
				const fix = await attemptAutoFix(tokenize(code), err.message, err.stack, blockKey);
				if (fix.success) {
					const stored = expand(fix.code);
					sc.codeBlocks.push(stored);
					// The fix ran tokenized; record the stored text so hot reload sees it unchanged.
					const rt = _blockRuntimes.get(blockKey);
					if (rt) rt.code = stored;
					fixed++;
				}
				else {
					// Dropped: free the key so the next block starts clean.
					teardownBlock(_blockRuntimes.get(blockKey));
					_blockStates.delete(blockKey);
					failed++;
				}
			}
		}
		renderDomSceneList();
		notifyCodeEditorExternalChange();
		return { sceneId: sc.id, fixed, failed };
	},
	appendChat: (apiMsgs, displayMsgs) => {
		messages.push(...apiMsgs);
		displayMessages.push(...displayMsgs);
		renderDomChat();
	},
	recordMerge: (info) => {
		GSContext.recordUserTurn({ text: info.userText, backend: selectedBackend, model: getActiveModelDisplayName() });
		GSContext.recordAssistantTurn({ raw: info.raw, display: info.display, backend: selectedBackend, model: getActiveModelDisplayName() });
		GSContext.recordMerge(info);
	},
	updateStatus: (t, c) => updateStatus(t, c)
});
window.GSMerge = GSMerge; // console / test access

function updateStatus(text, className) {
	// Keep the text/class on #status for anything that reads it. The element
	// stays hidden (see index.html); the head-locked HUD badge is not drawn.
	if (statusElement) {
		statusElement.textContent = text;
		statusElement.className = className || '';
	}
}

// Hide/show the VR menu (headset) or the menu window (windowed view). In a
// headset the head-locked HUD stays so the UI can always be brought back; in
// the windowed view a Show UI button appears after minimize and does the same.
function setUiCollapsed(collapsed) {
	if (displayOnlyMode) collapsed = true;
	uiCollapsed = collapsed;
	const immersive = renderer.xr.isPresenting;
	if (immersive) {
		applyXrPanelVisibility(true);
	} else {
		setDesktopChatMinimized(collapsed);
	}

	updateUiToggleDOM();
	updateStatus(collapsed ? 'UI hidden' : '', '');
}

function toggleUi() {
	setUiCollapsed(!uiCollapsed);
}

function updateUiToggleDOM() {
	// Page-level button: only "Show UI", and only while the menu is hidden.
	// The menu window's '_' button is what hides it. The in-headset HUD
	// toggle still switches between Hide UI and Show UI.
	const btn = document.getElementById('ui-toggle');
	if (btn) {
		btn.textContent = 'Show UI';
		btn.hidden = !uiCollapsed || displayOnlyMode;
	}
	const vrBtn = document.getElementById('gs-vr-hud-toggle');
	if (vrBtn) {
		vrBtn.textContent = uiCollapsed ? 'Show UI' : 'Hide UI';
		vrBtn.setAttribute('aria-pressed', uiCollapsed ? 'true' : 'false');
	}
}

// ============================================================================
// Locomotion (left thumbstick = move, right thumbstick = turn)
// ============================================================================
// Modes cycle Off → Planar → Free-roam:
//   • off    — thumbsticks scroll whatever VR window content is under that hand's ray.
//   • planar — left stick moves on the horizontal plane (in/out + strafe)
//              relative to camera yaw; no vertical from the left stick.
//   • free   — left stick uses the same level yaw translation; vertical
//              (right stick / Q/E) follows the camera's tilted local up.
// Right stick left/right yaws around world up (0, 1, 0), not the camera's tilted local up, in both movement modes, orbiting the camera world position so the view origin stays put.
const _locoQuat = new THREE.Quaternion();
const _locoRigQuat = new THREE.Quaternion();
const _locoForward = new THREE.Vector3();
const _locoRight = new THREE.Vector3();
const _locoMove = new THREE.Vector3();
const _locoHead = new THREE.Vector3();
const _LOCO_UP = new THREE.Vector3(0, 1, 0);

function cycleLocomotionMode() {
	locomotionMode = locomotionMode === 'off' ? 'planar'
		: locomotionMode === 'planar' ? 'free' : 'off';
	const label = locomotionMode === 'off' ? 'Locomotion off — thumbsticks scroll'
		: locomotionMode === 'planar' ? 'Locomotion: First Person (left move/turn · right stick turn/height)'
		: 'Locomotion: WASD/free-fly (left move/turn · right stick turn/height)';
	updateStatus(label, locomotionMode === 'off' ? '' : 'connected');
	// Keep the desktop dropdown in sync (it has no "off" option, so leave it
	// showing whichever nav type was last active if the VR grip cycled to off).
	if (dchatNavType && locomotionMode !== 'off') dchatNavType.value = locomotionMode;
}

dchatNavType?.addEventListener('change', () => {
	locomotionMode = dchatNavType.value;
});

const _locoUpLocal = new THREE.Vector3();

// Movement math for the VR thumbsticks and Cardboard hold-to-walk. mx/my
// are strafe/forward (-1..1, forward = negative my to match "push stick up
// = forward"), rx is yaw turn, ry is vertical (-1..1, positive = up).
// refCamera supplies the facing direction (xrCam in VR, `camera` in Cardboard).
//
// Both nav types: forward/back is the camera look direction with pitch
// removed (projected onto world XZ, so yaw around world up, level with the
// ground). Strafe is perpendicular to that level forward, also on XZ.
// Looking up or down does not fly you along the view ray.
// 'planar' (First Person): vertical (Q/E, right stick) is world up.
// 'free' (WASD): vertical is the camera's own local up, which tilts with pitch.
function applyLocomotionInput(dt, refCamera, mx, my, rx, ry) {
	if (!player || locomotionMode === 'off' || dt <= 0) return;

	if (mx !== 0 || my !== 0 || ry !== 0) {
		if (renderer.xr.isPresenting && viewOffset) {
			const xrCam = renderer.xr.getCamera();
			_locoQuat.copy(xrCam.quaternion);
			viewOffset.getWorldQuaternion(_locoRigQuat);
			_locoQuat.premultiply(_locoRigQuat);
		} else {
			refCamera.getWorldQuaternion(_locoQuat);
		}
		// View forward (camera local -Z), then pitch 0: keep only the XZ
		// projection so translation follows yaw, not look up/down.
		_locoForward.set(0, 0, -1).applyQuaternion(_locoQuat);
		const lookY = _locoForward.y;
		_locoForward.y = 0;
		if (_locoForward.lengthSq() < 1e-8) {
			// Look is parallel to world up, so the XZ projection vanished.
			// Camera up still carries yaw: it points opposite the heading
			// when looking up, and along the heading when looking down.
			_locoForward.set(0, 1, 0).applyQuaternion(_locoQuat);
			_locoForward.y = 0;
			if (lookY > 0) _locoForward.negate();
		}
		if (_locoForward.lengthSq() < 1e-8) _locoForward.set(0, 0, -1);
		_locoForward.normalize();
		// Level strafe: right = forward × worldUp (Y-up, camera looks down -Z).
		_locoRight.crossVectors(_locoForward, _LOCO_UP).normalize();
		let upVec;
		if (locomotionMode === 'planar') {
			upVec = _LOCO_UP; // global up - height is set by Q/E, unaffected by view direction
		} else {
			upVec = _locoUpLocal.set(0, 1, 0).applyQuaternion(_locoQuat); // local up - tilts with your view
		}
		_locoMove.set(0, 0, 0)
			.addScaledVector(_locoForward, -my) // push up = forward
			.addScaledVector(_locoRight, mx)    // push right = strafe right
			.addScaledVector(upVec, ry)          // Q/push right-stick up = ascend
			.multiplyScalar(MOVE_SPEED * dt);
		player.position.add(_locoMove);
	}

	// Turn (right stick x / no keyboard equivalent). Yaw around world up
	// (0, 1, 0), not the camera's tilted local up, orbiting the camera world
	// position so the view origin stays put and the rig turns around it.
	// Desktop never sends rx.
	if (rx !== 0) {
		const angle = -rx * TURN_SPEED * dt;
		camera.getWorldPosition(_locoHead);
		player.position.sub(_locoHead).applyAxisAngle(_LOCO_UP, angle).add(_locoHead);
		player.rotateOnWorldAxis(_LOCO_UP, angle);
	}
}

function updateLocomotion(dt, session) {
	if (!player || locomotionMode === 'off' || dt <= 0) return;

	const xrCam = renderer.xr.getCamera();
	let mx = 0, my = 0, rx = 0, ry = 0; // left x/y (move), right x (turn), right y (vertical)
	// Holding the origin gizmo: the controllers rotate the scene, not you.
	if (vrGizmoGrab) return;
	for (const source of session.inputSources) {
		const gp = source.gamepad;
		if (!gp || !gp.axes) continue;
		// That hand's stick is scrolling a VR window (stickScrollVrWindow).
		if (_stickOwnedByWindow[source.handedness]) continue;
		const axes = gp.axes;
		const ax = axes.length >= 4 ? axes[2] : (axes[0] || 0);
		const ay = axes.length >= 4 ? axes[3] : (axes[1] || 0);
		if (source.handedness === 'left') {
			// Direct mapping: previous transpose was wrong for Quest / current
			// OpenXR gamepads (strafe = horizontal, forward/back = vertical).
			if (Math.abs(ax) > THUMBSTICK_DEADZONE) mx = ax;
			if (Math.abs(ay) > THUMBSTICK_DEADZONE) my = ay;
		} else if (source.handedness === 'right') {
			if (Math.abs(ax) > THUMBSTICK_DEADZONE) rx = ax;
			// Right thumbstick vertical: push up to ascend (Q), pull down to
			// descend (E) - the flying-controls equivalent of Q/E.
			if (Math.abs(ay) > THUMBSTICK_DEADZONE) ry = -ay;
		}
	}

	applyLocomotionInput(dt, xrCam, mx, my, rx, ry);
}

// ============================================================================
// Controls tab: desktop/phone camera mode. The stock three.js controls from
// cameraControls.js, never used during an XR session or Cardboard (they drive
// the camera themselves) and disabled while typing into a text field.
//   orbit (default) OrbitControls around the scene origin · map MapControls ·
//   trackball TrackballControls · fly FlyControls · firstperson
//   PointerLockControls with the pointerlock example's WASD · off nothing.
// Saved values from 0.976 and earlier map orbit → orbit, free → firstperson,
// off → off.
// ============================================================================
const CAMERA_CONTROL_STORAGE_KEY = 'gs.cameraControlMode';

// Render distance: make the desktop/phone view draw everything VR draws.
// VR's far plane is RENDER_FAR metres from the headset, which starts at the
// player rig's eye (RENDER_EYE_HEIGHT above the rig). The windowed camera hangs
// in the same rig but usually not at the eye: it starts 4 m behind it, and
// Orbit / Map / Trackball zoom it further out while Fly / First person move it. With the same far value the
// desktop used to clip what VR still shows, so outside XR the far plane is
// pushed out by the camera's distance from the VR eye. With the camera at the
// eye that is exactly RENDER_FAR. VR and Cardboard use the far value as is.
// Near stays RENDER_NEAR everywhere.
// Scene code may still set camera.far / camera.near itself (e.g. a huge
// landscape). The new value then becomes the shared base for desktop and VR.
//
// On top of that the far plane always reaches the whole scene (sceneFit.js):
// far = max(the value above, distance from the camera to the far side of all
// scene content and every sky / HDRI dome × FAR_MARGIN), so nothing is clipped
// by render distance. The fit value moves in ~9% steps so a moving headset does
// not call XRSession.updateRenderState every frame (three.js copies
// camera.near/far into depthNear/depthFar whenever they change). Very large
// scenes raise near a little (far / 100000, at most 0.5 m) to keep depth
// precision; scenes under 10 km keep near 0.1.
let renderFarBase = RENDER_FAR;
let renderFarApplied = RENDER_FAR;
let renderNearBase = RENDER_NEAR;
let renderNearApplied = RENDER_NEAR;
const RENDER_NEAR_MAX = 0.5;
const RENDER_DEPTH_RATIO = 100000;
const _fitViewer = new THREE.Vector3();
const sceneFit = createSceneFit({
	scene,
	getRoots: () => userContentRoots(),
	exclude: (obj) => obj === arPlacementMarker || systemObjectIds.has(obj.uuid) || menuPriorityRoots.includes(obj),
	extraDomes: () => (vrSkybox ? [vrSkybox] : [])
});
/** Viewer position for the fit: the headset in VR, else the windowed camera. */
function sceneFitViewer() {
	if (renderer.xr.isPresenting) renderer.xr.getCamera().getWorldPosition(_fitViewer);
	else camera.getWorldPosition(_fitViewer);
	return _fitViewer;
}
function quantizeFar(d) {
	return d > 0 ? Math.pow(2, Math.ceil(Math.log2(d) * 8) / 8) : 0;
}
function sceneFitFar() {
	return quantizeFar(sceneFit.requiredFar(sceneFitViewer()));
}
const _renderEye = new THREE.Vector3();
const _renderCamPos = new THREE.Vector3();
function desktopRenderFarOffset() {
	if (renderer.xr.isPresenting || mobileXRMode || !player) return 0;
	player.updateWorldMatrix(true, false);
	_renderEye.set(0, RENDER_EYE_HEIGHT, 0);
	player.localToWorld(_renderEye);
	camera.getWorldPosition(_renderCamPos);
	return _renderCamPos.distanceTo(_renderEye);
}
function syncRenderDistance() {
	if (camera.far !== renderFarApplied) renderFarBase = camera.far; // changed by scene code
	if (camera.near !== renderNearApplied) renderNearBase = camera.near;
	const far = Math.max(renderFarBase + desktopRenderFarOffset(), sceneFitFar());
	const near = Math.max(renderNearBase, Math.min(RENDER_NEAR_MAX, far / RENDER_DEPTH_RATIO));
	if (far !== camera.far || near !== camera.near) {
		camera.far = far;
		camera.near = near;
		camera.updateProjectionMatrix();
	}
	renderFarApplied = far;
	renderNearApplied = near;
}
/**
 * Fit sky / HDRI domes and the render distance to the scene now (it also runs
 * by itself a few times a second). Scene code calls this after building a
 * scene; returns the content bounds and the fitted domes.
 */
function fitSceneNow() {
	const info = sceneFit.update(sceneFitViewer());
	sceneFit.fogFarFor(_fitViewer);
	syncRenderDistance();
	return { ...info, far: camera.far, near: camera.near };
}
window.gsFitScene = fitSceneNow;
window.gsSceneFit = {
	fit: fitSceneNow,
	info: () => ({ ...sceneFit.info(), far: camera.far, near: camera.near, requiredFar: sceneFit.requiredFar(sceneFitViewer()) }),
	domeMargin: DOME_MARGIN,
	farMargin: FAR_MARGIN
};
window.gsRenderDistance = {
	get near() { return camera.near; },
	/** Far distance from the viewer in VR (and the desktop base). */
	get far() { return renderFarBase; },
	/** Far plane the windowed camera uses right now (base + offset from the VR eye). */
	get desktopFar() { return renderFarBase + desktopRenderFarOffset(); },
	/** Far distance that reaches all scene content and domes from the viewer (sceneFit.js). */
	get sceneFar() { return sceneFitFar(); },
	defaults: { near: RENDER_NEAR, far: RENDER_FAR }
};

function cameraControlsSuspended() {
	return !!(renderer.xr.isPresenting || mobileXRMode);
}

const cameraControls = createCameraControls({
	camera,
	domElement: renderer.domElement,
	isSuspended: cameraControlsSuspended,
	onModeChange: () => renderCameraControlsUi(),
	onLockChange: (locked, why) => renderCameraControlsUi(why)
});

function refreshCameraControls() {
	cameraControls.refreshEnabled();
}

// The desktop controls move the camera inside the player rig; keep the rig at
// the origin so the camera's local pose is its world pose (and the Orbit
// target really is the scene origin).
function resetPlayerRig() {
	if (player) { player.position.set(0, 0, 0); player.rotation.set(0, 0, 0); }
	if (viewOffset) { viewOffset.position.set(0, 0, 0); viewOffset.rotation.set(0, 0, 0); }
}

// Reset Camera View / gamepad View / leaving VR or Cardboard: the default
// desktop view (camera at (0, 1.6, 4); Orbit, Map and Trackball look at the
// origin with their target there, Fly and First person face -Z).
function resetCameraView() {
	resetPlayerRig();
	cameraControls.reset();
}

// Orbit / Map / Trackball target, in world space (null in the other modes).
function orbitPivotWorld() {
	const t = cameraControls.target;
	if (!t) return null;
	const out = t.clone();
	if (camera.parent) { camera.parent.updateWorldMatrix(true, false); camera.parent.localToWorld(out); }
	return out;
}

// Clear scene and loading a scene put the Orbit / Map / Trackball target
// back on the scene origin if it was panned away.
function recenterOrbitPivot() {
	if (cameraControlsSuspended()) return;
	if (player && player.position.lengthSq() > 1e-8) resetPlayerRig();
	cameraControls.recenter();
}

// Compatible handles for scene code: gsOrbit (0.976) and window.controls (the
// name three.js examples use) both reach the active stock control.
window.gsOrbit = {
	/** World position the camera orbits (Orbit / Map / Trackball), else the origin. */
	pivot: () => (orbitPivotWorld() || ORBIT_TARGET.clone()).toArray(),
	recenter: () => recenterOrbitPivot()
};
window.gsControls = {
	modes: CAMERA_MODES.slice(),
	get mode() { return cameraControls.mode; },
	/** The active three.js controls instance (OrbitControls, MapControls, …) or null for Off. */
	get controls() { return cameraControls.controls; },
	setMode: (m) => setCameraControlMode(m),
	reset: () => resetCameraView()
};
{
	let userControls; // scene code may assign its own value
	Object.defineProperty(window, 'controls', {
		configurable: true,
		get() { return userControls !== undefined ? userControls : cameraControls.controls; },
		set(v) { userControls = v; }
	});
}

function renderCameraControlsUi(why) {
	const mode = cameraControls.mode;
	document.querySelectorAll('#dchat-camera-mode [data-camera-mode]').forEach((btn) => {
		const on = btn.dataset.cameraMode === mode;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
	document.querySelectorAll('[data-camera-help]').forEach((el) => {
		el.hidden = !el.dataset.cameraHelp.split(' ').includes(mode);
	});
	// PointerLockControls fires lock/unlock before it updates isLocked, so ask the document.
	const locked = mode === 'firstperson' && document.pointerLockElement === renderer.domElement;
	document.body.classList.toggle('gs-camera-locked', locked);
	const status = document.getElementById('dchat-controls-status');
	if (status) {
		status.textContent = mode === 'firstperson'
			? (locked ? 'Mouse look on. Press Esc to release.'
				: why === 'refused' ? 'The browser refused mouse look (Esc was just pressed). Click the scene again.' : '')
			: '';
	}
	window.gsRefreshTwinSticks?.(); // set up with the twin sticks further down
}

function setCameraControlMode(mode, { persist = true } = {}) {
	const prev = cameraControls.mode;
	resetPlayerRig();
	mode = cameraControls.setMode(mode);
	if (persist) {
		try { localStorage.setItem(CAMERA_CONTROL_STORAGE_KEY, mode); } catch { /* storage blocked */ }
	}
	renderCameraControlsUi();
	return prev;
}

document.querySelectorAll('#dchat-camera-mode [data-camera-mode]').forEach((btn) => {
	btn.addEventListener('click', () => setCameraControlMode(btn.dataset.cameraMode));
});

// A picked <select> option keeps keyboard focus (and would swallow the camera
// keys, since selects count as text entry); hand focus back to the page.
document.addEventListener('change', (e) => {
	if (e.target instanceof HTMLSelectElement) e.target.blur();
});

{
	let saved = null;
	try { saved = localStorage.getItem(CAMERA_CONTROL_STORAGE_KEY); } catch { /* storage blocked */ }
	const mode = normalizeCameraMode(saved);
	resetPlayerRig();
	camera.position.set(0, 1.6, 4);
	cameraControls.setMode(mode);
	cameraControls.reset();
	if (saved !== null && saved !== mode) {
		try { localStorage.setItem(CAMERA_CONTROL_STORAGE_KEY, mode); } catch { /* storage blocked */ }
	}
	renderCameraControlsUi();
}

// ============================================================================
// Origin rotation (Environment tab → Origin rotation; originGizmo.js)
// ============================================================================
// Rotates gsOriginRoot (the scene's content frame) about the origin. Saved in
// localStorage for this browser, and with the scene (`originRotation`
// { yaw, pitch, roll } in degrees) in scene files and Community uploads, so
// share links keep it. Scenes without the field load unrotated. Physics runs
// in the scene's own frame, so gravity turns with the scene; exports bake the
// rotation in (they use world transforms).
const ORIGIN_ROTATION_STORAGE_KEY = 'gs.originRotation';
const _originViewQ = new THREE.Quaternion();
originRotation = createOriginRotation({
	THREE,
	root: gsOriginRoot,
	getViewQuaternion: () => {
		const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
		return cam.getWorldQuaternion(_originViewQ);
	},
	// Axis-end clicks point the axis at the viewer: in the orbiting modes that is
	// the camera-to-origin line (the camera circles the origin); in first
	// person / fly / VR it is the camera's own backward axis (null → default).
	getViewDirection: (out) => {
		if (renderer.xr.isPresenting) return null;
		const mode = window.gsControls && window.gsControls.mode;
		if (mode !== 'orbit' && mode !== 'map' && mode !== 'trackball') return null;
		const o = gsOriginRoot.getWorldPosition(new THREE.Vector3());
		return camera.getWorldPosition(out).sub(o);
	},
	onChange: (rot, why) => {
		if (!isIdentityOriginRotation(rot)) adoptSceneContentIntoOrigin();
		if (why !== 'load') {
			try { localStorage.setItem(ORIGIN_ROTATION_STORAGE_KEY, JSON.stringify(rot)); } catch { /* storage blocked */ }
		}
		// The VR menu mirror only repaints while presenting (and runs before
		// its state is initialised when a saved rotation loads at startup).
		if (renderer.xr.isPresenting) vrWindows?.byName("menu")?.markDirty();
	},
	onRedraw: () => { if (renderer.xr.isPresenting) vrWindows?.byName("menu")?.markDirty(); }
});
{
	const mount = document.getElementById('dchat-origin');
	if (mount) originRotation.mount(mount);
	let saved = null;
	try { saved = JSON.parse(localStorage.getItem(ORIGIN_ROTATION_STORAGE_KEY) || 'null'); } catch { saved = null; }
	if (saved) originRotation.set(normalizeOriginRotation(saved), 'load');
}

/** A loaded scene brings its own origin rotation. Scenes saved before 0.98
 *  have none (= unrotated). */
function applySceneOriginRotation(data) {
	originRotation.set(normalizeOriginRotation(data && data.originRotation), 'scene');
}

function originRotationForScene() {
	return originRotationActive() ? { originRotation: originRotation.rotation } : {};
}

/** Signature for "has this scene changed since it was shared?" */
function shareSignature(codeBlocks) {
	return JSON.stringify([codeBlocks, originRotationActive() ? originRotation.rotation : null]);
}

window.gsOrigin = {
	/** The group scene content lives in while the origin is rotated. */
	root: gsOriginRoot,
	get rotation() { return originRotation.rotation; },
	set: (r) => originRotation.set(r),
	reset: () => originRotation.reset(),
	alignAxis: (axis, sign = 1) => originRotation.alignAxis(axis, sign),
	/** World point (e.g. the camera position or a raycast hit) → scene coordinates. */
	toLocal: (v) => { gsOriginRoot.updateWorldMatrix(true, false); return gsOriginRoot.worldToLocal(v.clone()); },
	/** Scene coordinates → world point. */
	toWorld: (v) => { gsOriginRoot.updateWorldMatrix(true, false); return gsOriginRoot.localToWorld(v.clone()); },
	_gizmo: originRotation
};

// ============================================================================
// Environment (2D / 3D) + Dependencies (THREE.js / ammo.js / p5.js)
// ============================================================================
// The dependency loader itself lives in index.html (it has to run before this
// module so any dependency that is switched on is already downloading). This section adds:
//   - the Environment tab's 2D/3D choice (2D: p5.js | blank canvas,
//     3D: THREE.js | raw WebGL), saved in localStorage;
//   - the Dependencies tab (which libraries load on startup);
//   - buildGsSettingsNote(): the short "editor settings" note that is sent
//     with each chat request so the AI knows the chosen environment and the
//     libraries it may use (see sendMessage / attemptAutoFix).
// Scene code gets libraries with `await gsRequire('ammo' | 'p5' | 'three')`,
// so saved/shared scenes still work if a viewer has a library switched off.
const GS_DEPS = window.GS_DEPS || null;
if (GS_DEPS) GS_DEPS.modules.three = THREE;

const SCENE_ENV_STORAGE_KEY = 'gs.sceneEnvironment';
const SCENE_ENV_DEFAULT = { dim: '3d', lib2d: 'p5', lib3d: 'three' };
const SCENE_ENV_LIBS = { '2d': ['p5', 'canvas'], '3d': ['three', 'webgl'] };
let sceneEnv = { ...SCENE_ENV_DEFAULT };
try {
	const saved = JSON.parse(localStorage.getItem(SCENE_ENV_STORAGE_KEY) || 'null');
	if (saved && typeof saved === 'object') {
		if (saved.dim === '2d' || saved.dim === '3d') sceneEnv.dim = saved.dim;
		if (SCENE_ENV_LIBS['2d'].includes(saved.lib2d)) sceneEnv.lib2d = saved.lib2d;
		if (SCENE_ENV_LIBS['3d'].includes(saved.lib3d)) sceneEnv.lib3d = saved.lib3d;
	}
} catch { /* storage blocked or bad JSON: keep defaults */ }

function currentSceneLib() {
	return sceneEnv.dim === '2d' ? sceneEnv.lib2d : sceneEnv.lib3d;
}

const SCENE_ENV_NOTES = {
	p5: 'The AI writes p5.js sketches (instance mode) and shows them on a panel in the scene, so they also work in a headset. Turns p5.js on in Dependencies.',
	canvas: 'The AI draws with the plain HTML canvas 2D API on a panel in the scene, with no extra library.',
	three: 'The AI builds 3D scenes with THREE.js. This is the default.',
	webgl: 'The AI writes raw WebGL (its own shaders and buffers) on a canvas shown in the scene, instead of THREE.js meshes.'
};

function setSceneEnv(patch, { persist = true } = {}) {
	sceneEnv = { ...sceneEnv, ...patch };
	if (persist) {
		try { localStorage.setItem(SCENE_ENV_STORAGE_KEY, JSON.stringify(sceneEnv)); } catch { /* storage blocked */ }
	}
	// 2D -> p5.js needs p5 on the page: switch it on (and start loading it).
	if (sceneEnv.dim === '2d' && sceneEnv.lib2d === 'p5' && GS_DEPS && !GS_DEPS.isEnabled('p5')) {
		GS_DEPS.setEnabled('p5', true);
	}
	renderSceneEnvUi();
}

function renderSceneEnvUi() {
	document.querySelectorAll('#dchat-dim-mode [data-dim]').forEach((btn) => {
		const on = btn.dataset.dim === sceneEnv.dim;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
	const lib = currentSceneLib();
	document.querySelectorAll('#dchat-dim-sub [data-dim-lib]').forEach((btn) => {
		btn.hidden = btn.dataset.forDim !== sceneEnv.dim;
		const on = btn.dataset.dimLib === lib;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
	const note = document.getElementById('dchat-dim-note');
	if (note) note.textContent = SCENE_ENV_NOTES[lib] || '';
}

document.querySelectorAll('#dchat-dim-mode [data-dim]').forEach((btn) => {
	btn.addEventListener('click', () => setSceneEnv({ dim: btn.dataset.dim }));
});
document.querySelectorAll('#dchat-dim-sub [data-dim-lib]').forEach((btn) => {
	btn.addEventListener('click', () => {
		setSceneEnv(btn.dataset.forDim === '2d' ? { lib2d: btn.dataset.dimLib } : { lib3d: btn.dataset.dimLib });
	});
});

const DEP_STATUS_LABELS = { idle: 'Not loaded', loading: 'Loading…', loaded: 'Loaded', error: 'Failed to load' };

function escapeDepText(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDependenciesUi() {
	const list = document.getElementById('dchat-deps-list');
	if (!list || !GS_DEPS) return;
	list.innerHTML = GS_DEPS.list.map((d) => {
		const enabled = GS_DEPS.isEnabled(d.id);
		const state = GS_DEPS.status(d.id) || 'idle';
		const src = d.loadedFrom || d.src;
		const shownSrc = /^https?:/.test(src) ? src : new URL(src, location.href).pathname;
		return `<div class="dchat-dep" data-dep="${escapeDepText(d.id)}">
			<div class="dchat-dep-head">
				<span class="dchat-dep-name">${escapeDepText(d.name)}</span>
				<span class="dchat-dep-version">${escapeDepText(d.version)}</span>
				<label class="dchat-dep-toggle" title="${d.builtIn ? 'Always loaded' : 'Load on startup and tell the AI it can use this'}">
					<input type="checkbox" data-dep-toggle="${escapeDepText(d.id)}" ${enabled ? 'checked' : ''} ${d.builtIn ? 'disabled' : ''} />
					${d.builtIn ? 'Built in' : 'On'}
				</label>
			</div>
			<div class="dchat-dep-desc">${escapeDepText(d.description)}</div>
			<div class="dchat-dep-meta">
				<span class="dchat-dep-status" data-state="${state}">${DEP_STATUS_LABELS[state] || state}</span>
				<span>${escapeDepText(shownSrc)}</span>
				<a href="${escapeDepText(d.homepage)}" target="_blank" rel="noopener">Docs</a>
			</div>
		</div>`;
	}).join('');
	const note = document.getElementById('dchat-deps-note');
	if (note) {
		const offButLoaded = GS_DEPS.list.filter((d) => !GS_DEPS.isEnabled(d.id) && GS_DEPS.status(d.id) === 'loaded');
		note.textContent = offButLoaded.length
			? `${offButLoaded.map((d) => d.name).join(', ')} stays loaded until you reload the page.`
			: 'Turning a library off takes effect on the next page load.';
	}
}

document.getElementById('dchat-deps-list')?.addEventListener('change', (e) => {
	const input = e.target.closest('[data-dep-toggle]');
	if (!input || !GS_DEPS) return;
	GS_DEPS.setEnabled(input.dataset.depToggle, input.checked);
});
if (GS_DEPS) GS_DEPS.onChange(renderDependenciesUi);
renderDependenciesUi();
renderSceneEnvUi();
if (sceneEnv.dim === '2d' && sceneEnv.lib2d === 'p5') setSceneEnv({}, { persist: false });

// Canvas surfaces: a <canvas> shown on a plane in the 3D scene so 2D (p5 /
// canvas) and raw-WebGL content is visible on desktop, phone and in a
// headset alike. The texture is re-uploaded every frame.
function gsCreateCanvasSurface(opts = {}) {
	const {
		width = 1024,
		height = 768,
		context = '2d',
		contextAttributes = {},
		widthMeters = 1.6,
		position = [0, 1.4, -2],
		name = 'gs-canvas-surface',
		addToScene = true
	} = opts;
	const canvas = opts.canvas || document.createElement('canvas');
	if (!opts.canvas) { canvas.width = width; canvas.height = height; }
	let ctx = null;
	if (context) {
		// preserveDrawingBuffer: the texture upload may happen after the
		// browser has presented the WebGL canvas, which would otherwise be blank.
		const attrs = context === '2d' ? contextAttributes : { preserveDrawingBuffer: true, antialias: true, ...contextAttributes };
		ctx = canvas.getContext(context, attrs);
		if (!ctx) throw new Error(`Could not create a "${context}" canvas context`);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
	mesh.name = name;
	mesh.position.set(position[0] || 0, position[1] || 0, position[2] || 0);
	const surface = {
		canvas, ctx, gl: context && context !== '2d' ? ctx : null, mesh, texture,
		autoUpdate: true,
		widthMeters,
		_aspect: 0,
		setSource(nextCanvas) {
			if (!nextCanvas || surface.canvas === nextCanvas) return;
			surface.canvas = nextCanvas;
			texture.image = nextCanvas;
			texture.needsUpdate = true;
		},
		update() {
			const c = surface.canvas;
			if (!c || !c.width || !c.height) return;
			const aspect = c.height / c.width;
			if (aspect !== surface._aspect) {
				surface._aspect = aspect;
				mesh.scale.set(surface.widthMeters, surface.widthMeters * aspect, 1);
			}
			if (surface.autoUpdate) texture.needsUpdate = true;
		},
		dispose() {
			gsSurfaces.delete(surface);
			const i = window._vrAnimations.indexOf(surface._tick);
			if (i >= 0) window._vrAnimations.splice(i, 1);
			if (surface.p5) { try { surface.p5.remove(); } catch { /* already removed */ } }
			surface.host?.remove();
			mesh.parent?.remove(mesh);
			mesh.geometry.dispose();
			material.dispose();
			texture.dispose();
		}
	};
	surface._tick = () => surface.update();
	surface.update();
	window._vrAnimations.push(surface._tick);
	gsSurfaces.add(surface);
	if (addToScene) getWorldContentParent().add(mesh);
	return surface;
}

// p5.js sketch (instance mode) shown on a canvas surface. p5 normally drives
// itself with window.requestAnimationFrame, which stops during an immersive
// XR session, so the app's render loop calls p.redraw() instead.
async function gsCreateP5Surface(sketch, opts = {}) {
	if (typeof sketch !== 'function') throw new Error('gsCreateP5Surface(sketch): sketch must be a function (p) => { p.setup = ...; p.draw = ... }');
	if (typeof window.gsRequire !== 'function') throw new Error('gsRequire is unavailable (dependency loader missing from index.html)');
	const P5 = await window.gsRequire('p5');
	const host = document.createElement('div');
	host.className = 'gs-p5-host';
	host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
	document.body.appendChild(host);
	const placeholder = document.createElement('canvas');
	placeholder.width = opts.width || 800;
	placeholder.height = opts.height || 600;
	const surface = gsCreateCanvasSurface({ ...opts, canvas: placeholder, context: null, name: opts.name || 'gs-p5-surface' });
	surface.host = host;
	surface.looping = true;
	let lastTime = 0;
	const wrapped = (p) => {
		const nativeNoLoop = p.noLoop.bind(p);
		p.loop = () => { surface.looping = true; };
		p.noLoop = () => { surface.looping = false; };
		sketch(p);
		nativeNoLoop(); // p5 draws once after setup, then the app drives frames
	};
	const instance = new P5(wrapped, host);
	surface.p5 = instance;
	const baseTick = surface._tick;
	surface._tick = (time) => {
		if (instance.canvas && surface.canvas !== instance.canvas) surface.setSource(instance.canvas);
		if (surface.looping && instance._setupDone !== false && typeof instance.draw === 'function') {
			const t = typeof time === 'number' ? time : performance.now();
			instance.deltaTime = lastTime ? t - lastTime : 16.7;
			lastTime = t;
			try { instance.redraw(); } catch (e) { console.error('p5 sketch error:', e); surface.looping = false; }
		}
		baseTick();
	};
	const i = window._vrAnimations.indexOf(baseTick);
	if (i >= 0) window._vrAnimations[i] = surface._tick;
	return surface;
}

window.gsCreateCanvasSurface = gsCreateCanvasSurface;

// ----------------------------------------------------------------------------
// Pointer input for canvas surfaces (p5 sketches and blank canvases)
// ----------------------------------------------------------------------------
// A controller ray (or a Quest hand's pinch ray), a desktop mouse or a phone
// touch on a surface mesh is turned into pointer + mouse events on the
// surface's canvas, at the matching canvas pixel. p5 listens on window and
// computes mouseX/mouseY from the canvas's client rect, so the events carry
// clientX/clientY in that rect (the p5 host is laid out off-screen); a canvas
// that isn't in the document gets canvas-pixel clientX/offsetX instead.
// This only reads the surface; the per-frame texture upload is untouched.
const _surfaceRaycaster = new THREE.Raycaster();
const _surfaceMeshes = [];
const _surfaceHover = [null, null];     // per XR controller: { surface, uv }
const _surfacePressed = [null, null];   // per XR controller: surface held by the trigger

function surfaceForMesh(mesh) {
	for (const sf of gsSurfaces) if (sf.mesh === mesh) return sf;
	return null;
}

/** First canvas-surface hit along the raycaster's ray, or null. */
function intersectCanvasSurfaces(raycaster) {
	if (!gsSurfaces.size) return null;
	_surfaceMeshes.length = 0;
	for (const sf of gsSurfaces) {
		const m = sf.mesh;
		if (m && m.parent && m.visible) _surfaceMeshes.push(m);
	}
	if (!_surfaceMeshes.length) return null;
	const hits = raycaster.intersectObjects(_surfaceMeshes, false);
	for (const h of hits) {
		if (!h.uv) continue;
		const surface = surfaceForMesh(h.object);
		if (surface) return { surface, uv: h.uv.clone(), point: h.point, face: h.face, distance: h.distance };
	}
	return null;
}

function dispatchSurfacePointer(surface, uv, type, { pointerId = 1, pressed = false } = {}) {
	const canvas = surface && surface.canvas;
	if (!canvas || !uv) return;
	const u = Math.min(1, Math.max(0, uv.x));
	const v = Math.min(1, Math.max(0, 1 - uv.y));
	const rect = canvas.isConnected ? canvas.getBoundingClientRect() : null;
	let clientX, clientY, offsetX, offsetY;
	if (rect && rect.width > 0 && rect.height > 0) {
		offsetX = u * rect.width;
		offsetY = v * rect.height;
		clientX = rect.left + offsetX;
		clientY = rect.top + offsetY;
	} else {
		offsetX = clientX = u * canvas.width;
		offsetY = clientY = v * canvas.height;
	}
	const buttons = pressed ? 1 : 0;
	const init = {
		bubbles: true, cancelable: true, composed: true, view: window,
		clientX, clientY, screenX: clientX, screenY: clientY, button: 0, buttons
	};
	const fire = (ev) => {
		Object.defineProperty(ev, 'offsetX', { value: offsetX });
		Object.defineProperty(ev, 'offsetY', { value: offsetY });
		canvas.dispatchEvent(ev);
	};
	const pointer = (t) => fire(new PointerEvent(t, { ...init, pointerId, pointerType: 'mouse', isPrimary: true, pressure: pressed ? 0.5 : 0 }));
	const mouse = (t) => fire(new MouseEvent(t, init));
	if (type === 'move') { pointer('pointermove'); mouse('mousemove'); }
	else if (type === 'down') { pointer('pointerdown'); mouse('mousedown'); }
	else if (type === 'up') { pointer('pointerup'); mouse('mouseup'); mouse('click'); }
	else if (type === 'cancel') { pointer('pointerup'); mouse('mouseup'); }
}

/**
 * One XR controller's ray vs the canvas surfaces. A window hit that is closer
 * wins (returns null). Sends pointermove when the hit pixel changes and puts
 * the reticle on the sketch as a small white dot.
 */
function updateSurfacePointer(i, rayOrigin, rayDir, uiIntersects, reticle) {
	// Surfaces are world content, so they stay clickable with the UI hidden.
	let surfHit = null;
	if (gsSurfaces.size) {
		_surfaceRaycaster.set(rayOrigin, rayDir);
		surfHit = intersectCanvasSurfaces(_surfaceRaycaster);
		if (surfHit && uiIntersects.length > 0 && uiIntersects[0].distance <= surfHit.distance) surfHit = null;
	}
	const pressedSurface = _surfacePressed[i];
	if (surfHit && (!pressedSurface || surfHit.surface === pressedSurface)) {
		const prev = _surfaceHover[i];
		if (!prev || prev.surface !== surfHit.surface || !prev.uv.equals(surfHit.uv)) {
			dispatchSurfacePointer(surfHit.surface, surfHit.uv, 'move', { pointerId: 10 + i, pressed: !!pressedSurface });
		}
		_surfaceHover[i] = { surface: surfHit.surface, uv: surfHit.uv };
	} else if (!pressedSurface) {
		_surfaceHover[i] = null;
	}
	if (surfHit && reticle) {
		reticle.position.copy(surfHit.point);
		_tmpSurfNormal.copy(surfHit.face.normal).transformDirection(surfHit.surface.mesh.matrixWorld);
		if (_tmpSurfNormal.dot(rayDir) > 0) _tmpSurfNormal.negate();
		reticle.lookAt(surfHit.point.x + _tmpSurfNormal.x, surfHit.point.y + _tmpSurfNormal.y, surfHit.point.z + _tmpSurfNormal.z);
		reticle.material.color.setHex(0xffffff);
		reticle.visible = true;
	}
	return surfHit;
}
const _tmpSurfNormal = new THREE.Vector3();

// Desktop mouse / phone touch on a surface in the 3D view. Capture phase on
// the WebGL canvas so a press that lands on a sketch doesn't also orbit.
const _surfaceNdc = new THREE.Vector2();
let _desktopSurfaceDrag = null; // { surface, pointerId }
function desktopSurfaceHit(e) {
	if (renderer.xr.isPresenting || mobileXRMode) return null;
	const r = renderer.domElement.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	_surfaceNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
	_surfaceRaycaster.setFromCamera(_surfaceNdc, camera);
	return intersectCanvasSurfaces(_surfaceRaycaster);
}
renderer.domElement.addEventListener('pointerdown', (e) => {
	if (e.button !== 0 && e.pointerType === 'mouse') return;
	const hit = desktopSurfaceHit(e);
	if (!hit) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	_desktopSurfaceDrag = { surface: hit.surface, pointerId: e.pointerId };
	try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
	dispatchSurfacePointer(hit.surface, hit.uv, 'move', { pressed: false });
	dispatchSurfacePointer(hit.surface, hit.uv, 'down', { pressed: true });
}, true);
renderer.domElement.addEventListener('pointermove', (e) => {
	if (_desktopSurfaceDrag) {
		if (e.pointerId !== _desktopSurfaceDrag.pointerId) return;
		e.stopImmediatePropagation();
		const hit = desktopSurfaceHit(e);
		if (hit && hit.surface === _desktopSurfaceDrag.surface) dispatchSurfacePointer(hit.surface, hit.uv, 'move', { pressed: true });
		return;
	}
	if (!gsSurfaces.size || e.buttons) return;
	const hit = desktopSurfaceHit(e);
	if (hit) dispatchSurfacePointer(hit.surface, hit.uv, 'move', { pressed: false });
}, true);
const endDesktopSurfaceDrag = (e) => {
	if (!_desktopSurfaceDrag || e.pointerId !== _desktopSurfaceDrag.pointerId) return;
	e.stopImmediatePropagation();
	const drag = _desktopSurfaceDrag;
	_desktopSurfaceDrag = null;
	const hit = desktopSurfaceHit(e);
	const uv = hit && hit.surface === drag.surface ? hit.uv : null;
	if (uv) dispatchSurfacePointer(drag.surface, uv, e.type === 'pointercancel' ? 'cancel' : 'up');
	else dispatchSurfacePointer(drag.surface, { x: 0.5, y: 0.5 }, 'cancel');
};
renderer.domElement.addEventListener('pointerup', endDesktopSurfaceDrag, true);
renderer.domElement.addEventListener('pointercancel', endDesktopSurfaceDrag, true);
// p5Import.js checks this and skips its own pointer bridge (no double events).
window.gsSurfacePointerInput = true;

window.gsCreateP5Surface = gsCreateP5Surface;

// Hooks for p5Import.js: where world content goes (AR placement root in
// Walk-in-AR) and a way to add/remove session code blocks, so an imported
// sketch is saved with the scene and shows up in the code window.
window.gsGetWorldContentParent = getWorldContentParent;
// Blocks run under their session/scene key (like chat blocks) so Code-tab hot
// reload knows them: an unchanged import isn't re-run, and an edited one is
// torn down (iframe + panel) before it runs again.
function rekeyBlockRuntimes(pairs) {
	const moved = [];
	for (const [from, to] of pairs) {
		if (from === to) continue;
		const rt = _blockRuntimes.get(from);
		if (rt) { _blockRuntimes.delete(from); moved.push([to, rt, _blockStates.get(from)]); _blockStates.delete(from); }
	}
	for (const [to, rt, st] of moved) { rt.key = to; _blockRuntimes.set(to, rt); if (st) _blockStates.set(to, st); }
}
window.gsSessionCode = {
	async add(code) {
		await executeVrCode(code, sessionBlockKey(executedCodeBlocks.length));
		executedCodeBlocks.push(code);
		notifyCodeEditorExternalChange();
		renderDomSceneList();
	},
	removeWhere(match) {
		let removed = 0;
		const keep = (list, keyOf) => {
			const pairs = [];
			const out = [];
			list.forEach((c, i) => {
				if (match(c)) {
					removed++;
					const rt = _blockRuntimes.get(keyOf(i));
					if (rt) teardownBlock(rt);
				} else {
					pairs.push([keyOf(i), keyOf(out.length)]);
					out.push(c);
				}
			});
			rekeyBlockRuntimes(pairs);
			return out;
		};
		executedCodeBlocks = keep(executedCodeBlocks, sessionBlockKey);
		const sc = activeScene;
		if (sc && Array.isArray(sc.codeBlocks)) sc.codeBlocks = keep(sc.codeBlocks, (i) => sceneBlockKey(sc, i));
		if (removed) { notifyCodeEditorExternalChange(); renderDomSceneList(); }
		return removed;
	}
};

function buildGsSettingsNote() {
	const lines = ['[GS editor settings: chosen by the user in the editor. Follow them unless this message asks for something else. Do not mention this note.]'];
	const lib = currentSceneLib();
	if (lib === 'three') {
		lines.push('Environment: 3D, THREE.js (default). Build with THREE as usual.');
	} else if (lib === 'webgl') {
		lines.push("Environment: 3D, raw WebGL. Write plain WebGL (your own shaders, buffers and gl.draw* calls) instead of THREE meshes and materials. Get a context with `const surf = gsCreateCanvasSurface({ context: 'webgl2', width: 1024, height: 768 }); const gl = surf.gl;` (it shows the canvas on a panel in the scene and re-uploads it every frame) and draw in a window._vrAnimations callback.");
	} else if (lib === 'p5') {
		lines.push('Environment: 2D, p5.js. Write a p5.js sketch in instance mode and show it with `window.mySketch = await gsCreateP5Surface((p) => { p.setup = () => { p.createCanvas(800, 600); }; p.draw = () => { p.background(20); /* ... */ }; });`. Call every p5 function on `p` (never global mode). The app drives p.draw every frame, also in a headset. Pointer input reaches the sketch on desktop, phone and in a headset (VR controller ray + trigger), so p.mouseX, p.mouseY, p.mouseIsPressed, p.mousePressed and p.mouseDragged work; keyboard input does not, use gsGamepad or window listeners for that.');
	} else if (lib === 'canvas') {
		lines.push('Environment: 2D, blank HTML canvas (no library). Draw with the Canvas 2D API: `const surf = gsCreateCanvasSurface({ width: 1024, height: 768 }); const ctx = surf.ctx;` and animate in a window._vrAnimations callback.');
	}
	if (lib !== 'three') {
		lines.push('Canvas surface options: width, height (pixels), widthMeters (panel width, default 1.6), position [x, y, z] (default [0, 1.4, -2]). The returned object has { canvas, ctx, gl, mesh, texture, dispose() }; keep it on window to reuse it in later blocks.');
	}
	if (GS_DEPS) {
		const deps = GS_DEPS.list.map((d) => `${d.name} ${d.builtIn ? '(always loaded)' : GS_DEPS.isEnabled(d.id) ? '(on)' : '(off)'}`);
		lines.push(`Dependencies on this page: ${deps.join(', ')}. Get a library with \`await gsRequire('ammo' | 'p5' | 'three')\`.`);
		if (GS_DEPS.isEnabled('ammo')) {
			lines.push("Physics: when the scene needs gravity, collisions, rigid bodies, ragdolls, vehicles or other physics, use ammo.js: `const Ammo = await gsRequire('ammo');` (already initialised and cached; never call Ammo() yourself). Create one btDiscreteDynamicsWorld (btDefaultCollisionConfiguration, btCollisionDispatcher, btDbvtBroadphase, btSequentialImpulseConstraintSolver), store it on window (e.g. window.physicsWorld) so later blocks reuse it, step it with world.stepSimulation(dt, 10) in a window._vrAnimations callback, and copy each body's motion-state transform onto its THREE mesh every frame. Free temporary Ammo objects with Ammo.destroy(). Units are metres; the floor is y = 0.");
		} else {
			lines.push('ammo.js is switched off in Dependencies: only use it if the user asks for real physics; simple hand-written motion is fine otherwise.');
		}
	}
	if (originRotationActive()) {
		const r = originRotation.rotation;
		lines.push(`Origin rotation: the user turned the scene's frame (yaw ${r.yaw}°, pitch ${r.pitch}°, roll ${r.roll}°) in Environment. Keep writing in scene coordinates with scene.add(...) as usual (floor y = 0); the app rotates it. Convert world points (camera position, raycast hits) with gsOrigin.toLocal(v) before using them as positions.`);
	}
	lines.push("Game controllers (Xbox, PlayStation, other USB/Bluetooth pads): `gsGamepad.connected`, `gsGamepad.axis('leftX' | 'leftY' | 'rightX' | 'rightY')` (-1..1, deadzone applied, up is negative), `gsGamepad.button('A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'View' | 'Menu' | 'LS' | 'RS' | 'Up' | 'Down' | 'Left' | 'Right')` (0..1), `gsGamepad.pressed(name)`, `gsGamepad.justPressed(name)` (true for one frame), `gsGamepad.onButton(name, fn)`, `gsGamepad.rumble(ms, strength)`. The sticks move the editor camera by default; set `gsGamepad.captureCamera = true` when the scene uses the sticks itself (a game character, a vehicle). Headset (WebXR) controllers are separate and are not covered by gsGamepad.");
	return lines.join('\n');
}

// Adds the settings note to the newest user message of an outgoing request
// (only the copy that is sent; the stored chat history stays clean).
function withGsSettingsNote(outgoing) {
	let note;
	try { note = buildGsSettingsNote(); } catch (e) { console.error('settings note failed:', e); return outgoing; }
	for (let i = outgoing.length - 1; i >= 0; i--) {
		const m = outgoing[i];
		if (m.role !== 'user') continue;
		const copy = { ...m };
		if (typeof copy.content === 'string') {
			copy.content = `${note}\n\n${copy.content}`;
		} else if (Array.isArray(copy.content)) {
			copy.content = [{ type: 'text', text: note }, ...copy.content];
		}
		const out = outgoing.slice();
		out[i] = copy;
		return out;
	}
	return outgoing;
}

// ============================================================================
// Game controllers (browser Gamepad API): Xbox Series X|S, Xbox One,
// DualSense / DualShock, Switch Pro and other pads, over USB or Bluetooth.
// Separate from WebXR headset controllers, which come through the XR
// session's inputSources (see updateLocomotion).
//   The sticks feed the active stock three.js control (updateGamepadCamera):
//   Orbit / Map: right stick orbits, left stick pans (Orbit: y dollies),
//              LT / RT zoom out / in.
//   First person: left stick walks, right stick looks.
//   Fly:       left stick moves, right stick yaws / pitches, LB / RB down / up.
//   Trackball: sticks unused (no programmatic API).
//   All:       Y switches Orbit <-> First person, View (Back) resets the view.
//   Off:       the controller does not move the camera.
// Browsers only reveal a pad after a button is pressed on it.
// ============================================================================
const GAMEPAD_BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
const GAMEPAD_BUTTON_ALIASES = { Back: 'View', Select: 'View', Start: 'Menu', L1: 'LB', R1: 'RB', L2: 'LT', R2: 'RT', L3: 'LS', R3: 'RS', Cross: 'A', Circle: 'B', Square: 'X', Triangle: 'Y', DUp: 'Up', DDown: 'Down', DLeft: 'Left', DRight: 'Right', Guide: 'Home' };
const GAMEPAD_STICK_DEADZONE = THUMBSTICK_DEADZONE;

function gamepadButtonIndex(name) {
	const key = GAMEPAD_BUTTON_ALIASES[name] || name;
	return GAMEPAD_BUTTON_NAMES.indexOf(key);
}

// Radial deadzone, rescaled so movement starts at 0 just past the edge.
function applyStickDeadzone(x, y, dz = GAMEPAD_STICK_DEADZONE) {
	const mag = Math.hypot(x, y);
	if (mag < dz) return [0, 0];
	const scaled = Math.min(1, (mag - dz) / (1 - dz)) / mag;
	return [x * scaled, y * scaled];
}

const gsGamepad = {
	connected: false,
	index: -1,          // navigator.getGamepads() index of the active pad
	id: '',
	mapping: '',
	pads: [],           // every connected pad: { index, id, mapping }
	captureCamera: false,
	deadzone: GAMEPAD_STICK_DEADZONE,
	_axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
	_buttons: new Array(GAMEPAD_BUTTON_NAMES.length).fill(0),
	_prev: new Array(GAMEPAD_BUTTON_NAMES.length).fill(0),
	_listeners: [],
	axis(name) { return this._axes[name] || 0; },
	button(name) { const i = gamepadButtonIndex(name); return i >= 0 ? this._buttons[i] || 0 : 0; },
	pressed(name) { return this.button(name) > 0.5; },
	justPressed(name) { const i = gamepadButtonIndex(name); return i >= 0 && this._buttons[i] > 0.5 && !(this._prev[i] > 0.5); },
	justReleased(name) { const i = gamepadButtonIndex(name); return i >= 0 && !(this._buttons[i] > 0.5) && this._prev[i] > 0.5; },
	onButton(name, fn) {
		const entry = { name: GAMEPAD_BUTTON_ALIASES[name] || name, fn };
		this._listeners.push(entry);
		return () => { const i = this._listeners.indexOf(entry); if (i >= 0) this._listeners.splice(i, 1); };
	},
	raw() { return this.index >= 0 ? (navigator.getGamepads?.() || [])[this.index] || null : null; },
	rumble(ms = 120, strength = 0.6) {
		const gp = this.raw();
		const act = gp?.vibrationActuator;
		if (!act?.playEffect) return Promise.resolve(false);
		const s = Math.max(0, Math.min(1, strength));
		return act.playEffect('dual-rumble', { duration: ms, strongMagnitude: s, weakMagnitude: s }).then(() => true, () => false);
	},
	_reset() {
		this.captureCamera = false;
		this._listeners = [];
	}
};
window.gsGamepad = gsGamepad;

function gamepadDisplayName(id) {
	const s = String(id || 'Game controller');
	// Chrome: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
	return s.replace(/\s*\((?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || 'Game controller';
}

let _gamepadToastTimer = null;
function showGamepadToast(text) {
	let el = document.getElementById('gs-gamepad-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'gs-gamepad-toast';
		el.setAttribute('role', 'status');
		document.body.appendChild(el);
	}
	el.textContent = text;
	el.classList.add('show');
	clearTimeout(_gamepadToastTimer);
	_gamepadToastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function renderGamepadUi() {
	const status = document.getElementById('dchat-gamepad-status');
	if (status) {
		status.textContent = gsGamepad.pads.length
			? gsGamepad.pads.map((p) => `🎮 ${gamepadDisplayName(p.id)}${p.mapping === 'standard' ? '' : ' (non-standard layout)'}`).join(' · ')
			: 'No controller detected. Connect one by USB or Bluetooth, then press any button on it.';
		status.classList.toggle('connected', gsGamepad.pads.length > 0);
	}
	document.body.classList.toggle('gs-gamepad-connected', gsGamepad.connected);
}

function refreshGamepadList() {
	const pads = Array.from(navigator.getGamepads?.() || []).filter((g) => g && g.connected);
	gsGamepad.pads = pads.map((g) => ({ index: g.index, id: g.id, mapping: g.mapping }));
	// Prefer the current pad, then any standard-mapping pad, then anything.
	const active = pads.find((g) => g.index === gsGamepad.index) || pads.find((g) => g.mapping === 'standard') || pads[0];
	gsGamepad.connected = !!active;
	gsGamepad.index = active ? active.index : -1;
	gsGamepad.id = active ? active.id : '';
	gsGamepad.mapping = active ? active.mapping : '';
	if (!active) {
		gsGamepad._buttons.fill(0);
		gsGamepad._prev.fill(0);
		for (const k of Object.keys(gsGamepad._axes)) gsGamepad._axes[k] = 0;
	}
	renderGamepadUi();
}

window.addEventListener('gamepadconnected', (e) => {
	refreshGamepadList();
	showGamepadToast(`🎮 ${gamepadDisplayName(e.gamepad.id)} connected`);
});
window.addEventListener('gamepaddisconnected', (e) => {
	refreshGamepadList();
	showGamepadToast(`🎮 ${gamepadDisplayName(e.gamepad.id)} disconnected`);
});

function pollGamepads() {
	if (!navigator.getGamepads) return;
	if (!gsGamepad.connected) {
		// Some browsers skip gamepadconnected for pads already awake at load.
		if (Array.from(navigator.getGamepads()).some((g) => g && g.connected)) refreshGamepadList();
		if (!gsGamepad.connected) return;
	}
	const gp = gsGamepad.raw();
	if (!gp || !gp.connected) { refreshGamepadList(); return; }
	const prev = gsGamepad._prev;
	const cur = gsGamepad._buttons;
	for (let i = 0; i < cur.length; i++) prev[i] = cur[i];
	for (let i = 0; i < cur.length; i++) {
		const b = gp.buttons[i];
		// Digital buttons report value 1 when pressed; a few pads only set .pressed.
		cur[i] = !b ? 0 : typeof b === 'number' ? b : (b.pressed && !b.value ? 1 : b.value || 0);
	}
	const ax = gp.axes || [];
	const [lx, ly] = applyStickDeadzone(ax[0] || 0, ax[1] || 0, gsGamepad.deadzone);
	const [rx, ry] = applyStickDeadzone(ax[2] || 0, ax[3] || 0, gsGamepad.deadzone);
	gsGamepad._axes.leftX = lx; gsGamepad._axes.leftY = ly;
	gsGamepad._axes.rightX = rx; gsGamepad._axes.rightY = ry;
	for (const { name, fn } of gsGamepad._listeners.slice()) {
		if (gsGamepad.justPressed(name)) {
			try { fn(name); } catch (e) { console.error('gsGamepad.onButton handler error:', e); }
		}
	}
}

// Moves the desktop/phone camera from the pad, matching the Controls tab mode.
// Game controller → the active stock control (see cameraControls.stick):
// Orbit / Map: right stick orbits, left stick pans (Orbit: y dollies in/out),
// LT/RT zoom. First person: left stick walks, right stick looks (through
// PointerLockControls' own mouse-look). Fly: left stick moves, right stick
// yaws/pitches, LB/RB down/up. Trackball: sticks unused. Y switches Orbit /
// First person, View resets the view.
function updateGamepadCamera(dt) {
	if (!gsGamepad.connected || dt <= 0) return null;
	if (cameraControlsSuspended() || gsGamepad.captureCamera) return null;
	if (cameraControls.mode === 'off') return null;
	if (gsGamepad.justPressed('Y')) {
		setCameraControlMode(cameraControls.mode === 'orbit' ? 'firstperson' : 'orbit');
		return null;
	}
	if (gsGamepad.justPressed('View')) { resetCameraView(); return null; }
	return {
		lx: gsGamepad.axis('leftX'), ly: gsGamepad.axis('leftY'),
		rx: gsGamepad.axis('rightX'), ry: gsGamepad.axis('rightY'),
		vertical: gsGamepad.button('RB') - gsGamepad.button('LB'),
		zoom: gsGamepad.button('RT') - gsGamepad.button('LT')
	};
}

// ============================================================================
// On-screen twin joysticks (First person and Fly, desktop and phone; see
// twinSticks.js). Left: move (y forward/back, x sideways). Right: look. Same
// deadzone as the gamepad; the values go to the stock control like the
// gamepad's. Hidden in the other modes, in VR and Cardboard, or when turned
// off in the Controls tab (saved per browser).
// ============================================================================
const TWIN_STICKS_STORAGE_KEY = 'gs.twinSticks';
let twinSticksEnabled = true;
try { twinSticksEnabled = localStorage.getItem(TWIN_STICKS_STORAGE_KEY) !== 'off'; } catch { /* storage blocked */ }
const twinSticks = createTwinSticks({
	// Nothing sits at the bottom of the page any more (the VR / version
	// buttons moved to the top of the window), so the sticks use the bottom edge.
	layout: () => ({ bottom: 0 })
});
const dchatTwinSticksToggle = document.getElementById('dchat-twin-sticks');
if (dchatTwinSticksToggle) {
	dchatTwinSticksToggle.checked = twinSticksEnabled;
	dchatTwinSticksToggle.addEventListener('change', () => {
		twinSticksEnabled = dchatTwinSticksToggle.checked;
		try { localStorage.setItem(TWIN_STICKS_STORAGE_KEY, twinSticksEnabled ? 'on' : 'off'); } catch { /* storage blocked */ }
		refreshTwinSticks();
	});
}
function refreshTwinSticks() {
	const want = twinSticksEnabled && STICK_MODES.has(cameraControls.mode) && !cameraControlsSuspended()
		&& !document.body.classList.contains('gs-xr-presenting');
	if (want !== twinSticks.visible) twinSticks.setVisible(want);
}
window.gsRefreshTwinSticks = refreshTwinSticks;
refreshTwinSticks();
window.gsTwinSticks = {
	get visible() { return twinSticks.visible; },
	get enabled() { return twinSticksEnabled; },
	axes: () => twinSticks.axes()
};

// Gamepad and on-screen sticks combined (each past the deadzone), one call
// into the stock control per frame.
const _clampAxis = (v) => Math.max(-1, Math.min(1, v));
function updateStickCamera(dt, pad) {
	refreshTwinSticks();
	const input = pad ? { ...pad } : { lx: 0, ly: 0, rx: 0, ry: 0, vertical: 0, zoom: 0 };
	if (twinSticks.visible) {
		const a = twinSticks.axes();
		const [lx, ly] = applyStickDeadzone(a.lx, a.ly, gsGamepad.deadzone);
		const [rx, ry] = applyStickDeadzone(a.rx, a.ry, gsGamepad.deadzone);
		input.lx = _clampAxis(input.lx + lx); input.ly = _clampAxis(input.ly + ly);
		input.rx = _clampAxis(input.rx + rx); input.ry = _clampAxis(input.ry + ry);
	}
	if (cameraControlsSuspended()) return;
	cameraControls.stick(dt, input);
}

function updateGamepads(dt) {
	pollGamepads();
	updateStickCamera(dt, updateGamepadCamera(dt));
}

refreshGamepadList();

// ============================================================================
// Event Handlers
// ============================================================================
sendButton.addEventListener('click', () => {
	const message = chatInput.value.trim();
	if (message) {
		sendMessage(message);
		chatInput.value = '';
	}
});

chatInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		const message = chatInput.value.trim();
		if (message) {
			sendMessage(message);
			chatInput.value = '';
		}
	}
});

// Restore-UI: the page-level Show UI button (visible only when collapsed).
const uiToggleBtn = document.getElementById('ui-toggle');
if (uiToggleBtn) uiToggleBtn.addEventListener('click', toggleUi);

// Speech-to-text: detect capture support and wire the DOM mic toggle.
initSpeech();
const micButton = document.getElementById('mic-button');
if (micButton) {
	micButton.addEventListener('click', toggleMicAlwaysOn);
	if (!speechSupported) {
		// Only happens with no MediaRecorder/getUserMedia (very old browsers) or a
		// non-secure context that hides mediaDevices entirely.
		micButton.disabled = true;
		micButton.title = 'Microphone capture not available (needs a secure context)';
	} else {
		micButton.title = 'Toggle always-on voice input (in-browser Whisper)';
	}
}
// Enter VR: ask for the mic up front for people who use it (see onEnterVrClickForMic).
if (xrEntryButton) xrEntryButton.addEventListener('click', onEnterVrClickForMic, true);
updateMicButtonDOM();
window.__gsMic = {
	cleanTranscript,
	state: () => ({ micMode, micListening, sttModelReady, sttPct, worker: !!sttWorker && !sttWorkerBroken, noise: vadNoise, threshold: vadThreshold(), ...micStats, status: micStatusEl ? micStatusEl.textContent : '' })
};

// ============================================================================
// Model selector: populated from whichever backends the server has API keys
// for (GET /api/backends). Selecting an option is sent along with every
// /api/chat and /api/fix-code request as `backend`.
// ============================================================================
async function refreshOllamaModelList() {
	if (!desktopOllamaModelSelect) return;
	desktopOllamaModelSelect.innerHTML = '<option>Checking for local Ollama...</option>';
	desktopOllamaModelSelect.disabled = true;
	try {
		const names = await listOllamaModels();
		desktopOllamaModelSelect.innerHTML = '';
		if (names.length === 0) {
			desktopOllamaModelSelect.innerHTML = '<option>No local models found (try "ollama pull llama3.2")</option>';
			selectedOllamaModel = null;
			return;
		}
		for (const name of names) {
			const opt = document.createElement('option');
			opt.value = name;
			opt.textContent = name;
			desktopOllamaModelSelect.appendChild(opt);
		}
		desktopOllamaModelSelect.disabled = false;
		selectedOllamaModel = names.includes('llama3.2:latest') ? 'llama3.2:latest' : names[0];
		desktopOllamaModelSelect.value = selectedOllamaModel;
	} catch (err) {
		console.error('Failed to reach local Ollama:', err);
		desktopOllamaModelSelect.innerHTML = '<option>Could not reach Ollama - see chat for details</option>';
		selectedOllamaModel = null;
	}
}

function updateOllamaRowVisibility() {
	if (!desktopOllamaModelRow) return;
	desktopOllamaModelRow.style.display = selectedBackend === 'ollama' ? 'flex' : 'none';
}

async function initModelSelect() {
	if (!desktopModelSelect) return;
	try {
		const res = await fetch('/api/prompts');
		cachedPrompts = await res.json();
		ChatPrompt.setDefaults(cachedPrompts);
	} catch (err) {
		console.error('Failed to load /api/prompts (needed for the Ollama backend):', err);
	}

	try {
		const res = await fetch('/api/backends');
		const { backends, default: defaultBackend } = await res.json();

		// "local: true" backends (currently just Ollama) additionally require
		// THIS PAGE to be on localhost - see the Private Network Access note
		// on OLLAMA_UNAVAILABLE_HOSTED_MSG above. That's a client-side fact
		// the server can't know, so it's applied on top of `available` here.
		desktopModelSelect.innerHTML = '';
		backendLabels = {};
		backendProviders = {};
		for (const [id, info] of Object.entries(backends)) {
			backendLabels[id] = info.label || id;
			if (info.provider) backendProviders[id] = info.provider;
			const usable = info.available && (!info.local || IS_LOCAL_PAGE);
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = usable
				? info.label
				: !info.available
					? `${info.label} — no API key set`
					: `${info.label} — only when run via python run.py`;
			opt.disabled = !usable;
			desktopModelSelect.appendChild(opt);
		}

		const firstUsable = Object.entries(backends).find(([, info]) => info.available && (!info.local || IS_LOCAL_PAGE))?.[0];
		const defaultUsable = backends[defaultBackend]?.available && (!backends[defaultBackend]?.local || IS_LOCAL_PAGE);
		selectedBackend = defaultUsable ? defaultBackend : (firstUsable || defaultBackend);
		desktopModelSelect.value = selectedBackend;
		updateOllamaRowVisibility();
		if (selectedBackend === 'ollama') refreshOllamaModelList();
	} catch (err) {
		console.error('Failed to load /api/backends:', err);
	}
}

desktopModelSelect?.addEventListener('change', () => {
	selectedBackend = desktopModelSelect.value;
	updateOllamaRowVisibility();
	if (selectedBackend === 'ollama') refreshOllamaModelList();
});

desktopOllamaModelSelect?.addEventListener('change', () => {
	selectedOllamaModel = desktopOllamaModelSelect.value;
});

initModelSelect();

// ============================================================================
// Desktop (non-AR) chat window: movable, resizable, floats over the 3D scene
// ============================================================================
// Chat inputs (Scene and Theme) are auto-growing <textarea>s: one line to
// start, growing with the text up to a max height (CSS max-height, ~7 lines)
// and scrolling after that. Any .value write (send clears it, voice input,
// the VR keyboard, tests) re-measures, because the instance's value setter
// is wrapped. A width change (panel resize, phone rotation) re-measures too.
// The input may also take at most CHAT_INPUT_PANEL_FRAC of its chat window
// and at most CHAT_INPUT_SHARE_FRAC of the space it shares with the history
// (data-gs-history), so a long draft never squeezes the history to a strip.
const CHAT_INPUT_PANEL_FRAC = 0.35;
const CHAT_INPUT_SHARE_FRAC = 0.5;
const CHAT_HISTORY_MIN_PX = 72;
function chatTextareaHistory(el) {
	const sel = el.dataset.gsHistory;
	return sel ? document.querySelector(sel) : null;
}
function chatTextareaCap(el, cs) {
	let max = parseFloat(cs.maxHeight);
	if (!Number.isFinite(max)) max = Infinity;
	const lh = parseFloat(cs.lineHeight) || 18;
	const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
		+ (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
	const min = Math.max(parseFloat(cs.minHeight) || 0, lh + chrome);
	const panel = el.closest('#desktop-chat');
	if (panel && panel.clientHeight) max = Math.min(max, panel.clientHeight * CHAT_INPUT_PANEL_FRAC);
	const hist = chatTextareaHistory(el);
	if (hist && hist.clientHeight) {
		const shared = hist.getBoundingClientRect().height + el.getBoundingClientRect().height;
		max = Math.min(max, shared * CHAT_INPUT_SHARE_FRAC);
	}
	if (!Number.isFinite(max)) return max;
	// Whole lines only. At least two when the history still keeps
	// CHAT_HISTORY_MIN_PX next to them (a short window), else one.
	let floorLines = 1;
	if (hist && hist.clientHeight) {
		const shared = hist.getBoundingClientRect().height + el.getBoundingClientRect().height;
		if (shared - (2 * lh + chrome) >= CHAT_HISTORY_MIN_PX) floorLines = 2;
	}
	const lines = Math.max(floorLines, Math.floor((max - chrome + 0.5) / lh));
	return Math.max(min, Math.min(parseFloat(cs.maxHeight) || Infinity, lines * lh + chrome));
}

function autosizeChatTextarea(el) {
	if (!el || !(el instanceof HTMLTextAreaElement)) return;
	if (!el.clientWidth) return; // hidden (other sub-tab): measured when shown
	const cs = getComputedStyle(el);
	const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
	const hist = chatTextareaHistory(el);
	const histAtBottom = !!hist && hist.scrollTop + hist.clientHeight >= hist.scrollHeight - 4;
	const keepHistory = () => { if (histAtBottom) hist.scrollTop = hist.scrollHeight; };
	if (!el.value) {
		// Empty: one line (rows=1); a long placeholder must not make it grow.
		el.style.height = '';
		el.style.overflowY = 'hidden';
		keepHistory();
		return;
	}
	const prevScroll = el.scrollTop;
	el.style.height = 'auto'; // (resets scrollTop; restored below)
	const want = el.scrollHeight + border;
	el.style.height = '';
	const max = chatTextareaCap(el, cs);
	const capped = Number.isFinite(max) && want > max;
	el.style.height = `${Math.ceil(capped ? max : want)}px`;
	el.style.overflowY = capped ? 'auto' : 'hidden';
	keepHistory();
	if (!capped) return;
	// Typing at the end keeps the caret line in view once it scrolls.
	el.scrollTop = el.selectionEnd === el.value.length ? el.scrollHeight : prevScroll;
}

// Enter sends; Shift+Enter (or Alt/Ctrl+Enter) adds a new line. On phones the
// on-screen keyboard has no Shift+Enter, so Enter adds a new line there and
// the Send button sends (the input keeps focus, so the keyboard stays up).
function chatEnterSends(e) {
	if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
	if (e.isComposing || e.keyCode === 229) return false; // IME candidate confirm
	if (e.isTrusted && _phoneLayout && !xrSessionActive()) return false;
	return true;
}

function initChatTextarea(el, onSend) {
	if (!el || !(el instanceof HTMLTextAreaElement)) return;
	const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
	Object.defineProperty(el, 'value', {
		configurable: true,
		get() { return proto.get.call(this); },
		set(v) { proto.set.call(this, v); autosizeChatTextarea(this); }
	});
	el.addEventListener('input', () => autosizeChatTextarea(el));
	el.addEventListener('keydown', (e) => {
		if (!chatEnterSends(e)) return;
		e.preventDefault();
		onSend();
	});
	if (typeof ResizeObserver !== 'undefined') {
		let lastW = 0;
		new ResizeObserver(() => {
			const w = el.clientWidth;
			if (w && Math.abs(w - lastW) > 0.5) { lastW = w; autosizeChatTextarea(el); }
		}).observe(el);
		// The cap follows the chat window's height (panel resize, keyboard).
		const panel = el.closest('#desktop-chat');
		if (panel) {
			let lastH = 0;
			new ResizeObserver(() => {
				const h = panel.clientHeight;
				if (h && Math.abs(h - lastH) > 0.5) { lastH = h; autosizeChatTextarea(el); }
			}).observe(panel);
		}
	}
	autosizeChatTextarea(el);
}

function sendDesktopChatInput() {
	const message = desktopChatInput.value.trim();
	if (message || pendingAttachments.length > 0) {
		sendMessage(message);
		desktopChatInput.value = '';
	}
}

desktopSendButton.addEventListener('click', sendDesktopChatInput);
initChatTextarea(desktopChatInput, sendDesktopChatInput);

desktopAttachButton?.addEventListener('click', () => desktopAttachInput.click());
// 📷 Take a photo (photoCapture.js): a captured photo is attached exactly like
// one picked with 📎 (addAttachments). In VR the preview video is drawn live
// on the menu window.
photoCapture = createPhotoCapture({
	panel: document.getElementById('gs-camera-panel'),
	button: document.getElementById('desktop-camera-button'),
	onPhoto: (file) => addAttachments([file]),
	isImmersive: () => !!renderer.xr.isPresenting,
	onLiveChange: (video) => { if (vrMainWindow) vrMainWindow.setLiveMedia(video); },
	onLayout: () => { if (vrMainWindow) vrMainWindow.markDirty(); }
});
window.gsPhotoCapture = photoCapture;
const sbsRender = createSbsRenderer({
	THREE,
	getRenderer: () => renderer,
	getScene: () => scene,
	getCamera: () => camera,
	hideSystemObjects: hideSystemObjectsForThumb,
});
mountRenderTab(sbsRender);
window.gsSbsRender = sbsRender;

// Passthrough / camera feed as a THREE.VideoTexture for scene code (shares the
// chat preview's hidden <video> and stream; passthroughTexture.js).
window.gsPassthroughTexture = gsCamPipeline.gsPassthroughTexture;
window.gsCamPipeline = gsCamPipeline; // tests / debugging
// 🛠 Technical mode (technicalMode.js): checkbox at the top of the always-
// visible 🛠 Technical tab; technical UI is marked data-gs-technical. Items register with registerTechnicalItem(); the first is the Quest
// passthrough camera ADB fix.
registerQuestPassthroughItem(photoCapture);
gsTechnicalMode.initTechnicalMode({
	tab: document.getElementById('dchat-tab-technical'),
	panel: document.getElementById('dchat-panel-technical'),
	checkbox: document.getElementById('dchat-technical-checkbox'),
	onLayout: () => { if (vrMainWindow) vrMainWindow.markDirty(); }
});
window.gsTechnicalMode = gsTechnicalMode;
// A short chat window grows (within the viewport) while the camera is open, so
// the preview fits between the messages and the buttons; it goes back on close.
(() => {
	const panel = document.getElementById('gs-camera-panel');
	if (!panel || !desktopChat) return;
	const fit = () => {
		const open = !panel.hidden && !renderer.xr.isPresenting && !desktopChat.classList.contains('expanded') &&
			!document.documentElement.classList.contains('gs-kb-chat');
		desktopChat.style.minHeight = '';
		if (!open) return;
		const top = desktopChat.getBoundingClientRect().top;
		const target = Math.floor(Math.min(700, window.innerHeight - Math.max(0, top) - 12));
		if (desktopChat.offsetHeight < target) desktopChat.style.minHeight = `${target}px`;
	};
	new MutationObserver(fit).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
	window.addEventListener('resize', () => { if (!panel.hidden) fit(); });
})();
// Enter VR / AR: someone who has taken photos before is asked for the camera
// now, before the headset session (the Quest Headset cameras prompt can end it).
if (xrEntryButton) xrEntryButton.addEventListener('click', () => { if (!renderer.xr.isPresenting) askCameraBeforeXr(); }, true);
desktopAttachInput?.addEventListener('change', (e) => {
	addAttachments(e.target.files);
	desktopAttachInput.value = '';
});

desktopFilesPickerButton?.addEventListener('click', () => openFilesPicker('scene'));
themeFilesPickerButton?.addEventListener('click', () => openFilesPicker('theme'));
filesPickerCancel?.addEventListener('click', closeFilesPicker);
filesPickerConfirm?.addEventListener('click', confirmFilesPicker);
filesPickerModal?.addEventListener('click', (e) => {
	if (e.target === filesPickerModal) closeFilesPicker();
});

dchatFilesUpload?.addEventListener('click', () => handleMenuAction('files:upload'));
dchatFilesInput?.addEventListener('change', (e) => {
	addFilesToLibrary(e.target.files);
	dchatFilesInput.value = '';
});
dchatFilesClear?.addEventListener('click', () => handleMenuAction('files:clear'));

if (desktopMicButton) {
	desktopMicButton.addEventListener('click', toggleMicAlwaysOn);
	if (!speechSupported) {
		desktopMicButton.disabled = true;
		desktopMicButton.title = 'Microphone capture not available (needs a secure context)';
	} else {
		desktopMicButton.title = 'Toggle always-on voice input (in-browser Whisper)';
	}
}

if (desktopChatMinimizeBtn) {
	// Minimize hides the same chrome the old Hide UI button did. A Show UI
	// button then appears so the panel can always be brought back.
	desktopChatMinimizeBtn.addEventListener('click', () => setUiCollapsed(true));
}
if (desktopChatExpandBtn) {
	desktopChatExpandBtn.addEventListener('click', () => toggleDesktopChatExpanded());
}

const CHAT_SIZE_KEY = 'carljr-chat-window';
let _chatSizeBeforeExpand = null;

function setDesktopChatMinimized(minimized) {
	desktopChat.classList.toggle('hidden', minimized);
	if (!minimized) fitDesktopChatToViewport();
}

function saveDesktopChatSize() {
	if (desktopChat.classList.contains('expanded')) return;
	// Off-screen while painted into VR; don't persist the parked rect.
	if (desktopChat.classList.contains('html-in-canvas-source')) return;
	// Size only: the window always opens at its default spot after a reload.
	try {
		const rect = desktopChat.getBoundingClientRect();
		localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({
			width: rect.width,
			height: rect.height
		}));
	} catch { /* ignore */ }
}

function isNarrowDesktopChat() {
	// Phones in landscape are wider than 720px but get the same "stay inside
	// the visible area" handling (_phoneLayout is set further down).
	return window.matchMedia('(max-width: 720px)').matches || !!_phoneLayout;
}

let _safeAreaProbe = null;
let _fitChatRaf = 0;

function readSafeAreaInsets() {
	if (!_safeAreaProbe) {
		_safeAreaProbe = document.createElement('div');
		_safeAreaProbe.setAttribute('aria-hidden', 'true');
		_safeAreaProbe.style.cssText = [
			'position:fixed',
			'top:0',
			'left:0',
			'visibility:hidden',
			'pointer-events:none',
			'padding-top:constant(safe-area-inset-top)',
			'padding-top:env(safe-area-inset-top,0px)',
			'padding-right:constant(safe-area-inset-right)',
			'padding-right:env(safe-area-inset-right,0px)',
			'padding-bottom:constant(safe-area-inset-bottom)',
			'padding-bottom:env(safe-area-inset-bottom,0px)',
			'padding-left:constant(safe-area-inset-left)',
			'padding-left:env(safe-area-inset-left,0px)'
		].join(';');
		document.documentElement.appendChild(_safeAreaProbe);
	}
	const cs = getComputedStyle(_safeAreaProbe);
	return {
		top: parseFloat(cs.paddingTop) || 0,
		right: parseFloat(cs.paddingRight) || 0,
		bottom: parseFloat(cs.paddingBottom) || 0,
		left: parseFloat(cs.paddingLeft) || 0
	};
}

// Visible rectangle in getBoundingClientRect coordinates. visualViewport
// excludes the URL bar and other browser chrome; safe-area insets cover the
// status bar and home indicator drawn on top of that viewport.
function desktopChatVisibleBox() {
	const vv = window.visualViewport;
	const safe = readSafeAreaInsets();
	const margin = 8;
	const width = vv && vv.width > 0 ? vv.width : window.innerWidth;
	const height = vv && vv.height > 0 ? vv.height : window.innerHeight;
	return {
		left: safe.left + margin,
		top: safe.top + margin,
		right: width - safe.right - margin,
		bottom: height - safe.bottom - margin
	};
}

// position:fixed top/left stay on the layout viewport in iOS Safari, while
// getBoundingClientRect is visual. The difference is visualViewport.offsetTop
// while chrome shows, and it changes when the URL bar hides. Measuring it
// from the panel avoids adding that offset a second time on browsers where
// fixed already tracks the visual viewport.
function desktopChatFixedShift() {
	const vv = window.visualViewport;
	const fallback = {
		top: vv ? vv.offsetTop : 0,
		left: vv ? vv.offsetLeft : 0
	};
	if (!desktopChat || !desktopChat.getClientRects().length) return fallback;
	const cs = getComputedStyle(desktopChat);
	const rect = desktopChat.getBoundingClientRect();
	const top = parseFloat(cs.top);
	const left = parseFloat(cs.left);
	if (!Number.isFinite(top) || !Number.isFinite(left)) return fallback;
	return { top: top - rect.top, left: left - rect.left };
}

function clampRectToBox(rect, box, minW = 0, minH = 0) {
	const maxW = Math.max(0, box.right - box.left);
	const maxH = Math.max(0, box.bottom - box.top);
	const width = Math.min(Math.max(rect.width, Math.min(minW, maxW)), maxW);
	const height = Math.min(Math.max(rect.height, Math.min(minH, maxH)), maxH);
	let left = rect.left;
	let top = rect.top;
	if (left + width > box.right) left = box.right - width;
	if (top + height > box.bottom) top = box.bottom - height;
	if (left < box.left) left = box.left;
	if (top < box.top) top = box.top;
	return { left, top, width, height };
}

function syncDesktopChatViewportVars(box, shift) {
	const root = document.documentElement.style;
	const names = ['--dchat-vv-top', '--dchat-vv-left', '--dchat-vv-width', '--dchat-vv-height'];
	if (!box) {
		for (const name of names) root.removeProperty(name);
		return;
	}
	const next = {
		'--dchat-vv-top': `${Math.round(box.top + shift.top)}px`,
		'--dchat-vv-left': `${Math.round(box.left + shift.left)}px`,
		'--dchat-vv-width': `${Math.round(Math.max(0, box.right - box.left))}px`,
		'--dchat-vv-height': `${Math.round(Math.max(0, box.bottom - box.top))}px`
	};
	for (const name of names) {
		if (root.getPropertyValue(name) !== next[name]) root.setProperty(name, next[name]);
	}
}

// Restores the saved size only. The window always opens at its default spot
// (the CSS top/left); left/top saved by older versions are ignored and
// dropped from storage. If the saved size would run past the viewport from
// the default spot, the window is nudged in (phones: fitDesktopChatToViewport).
function restoreDesktopChatSize() {
	try {
		const raw = localStorage.getItem(CHAT_SIZE_KEY);
		if (!raw) return;
		const s = JSON.parse(raw);
		if (!s || !s.width || !s.height) {
			localStorage.removeItem(CHAT_SIZE_KEY);
			return;
		}
		if ('left' in s || 'top' in s) {
			localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({ width: s.width, height: s.height }));
		}
		const narrow = isNarrowDesktopChat();
		let w = s.width;
		let h = s.height;
		if (narrow) {
			const box = desktopChatVisibleBox();
			if (box.right - box.left >= 32 && box.bottom - box.top >= 32) {
				const clamped = clampRectToBox({ left: box.left, top: box.top, width: w, height: h }, box, 280, 220);
				w = clamped.width;
				h = clamped.height;
			}
		} else {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const maxW = Math.max(280, vw - 16);
			const maxH = Math.max(220, vh - 16);
			const minW = Math.min(280, maxW);
			const minH = Math.min(220, maxH);
			w = Math.max(minW, Math.min(maxW, s.width));
			h = Math.max(minH, Math.min(maxH, s.height));
		}
		desktopChat.style.removeProperty('left');
		desktopChat.style.removeProperty('top');
		desktopChat.style.width = `${w}px`;
		desktopChat.style.height = `${h}px`;
		if (narrow) {
			desktopChat.style.right = 'auto';
			return; // fitDesktopChatToViewport() runs next and clamps it in.
		}
		// Desktop / tablets: default spot, nudged in only if the size overflows.
		const rect = desktopChat.getBoundingClientRect();
		const left = Math.max(0, Math.min(rect.left, window.innerWidth - rect.width));
		const top = Math.max(0, Math.min(rect.top, window.innerHeight - rect.height));
		if (Math.abs(left - rect.left) > 0.5) desktopChat.style.left = `${left}px`;
		if (Math.abs(top - rect.top) > 0.5) desktopChat.style.top = `${top}px`;
	} catch { /* ignore */ }
}

// Phones only. Always pulls the header (minimize / expand) fully inside the
// visual viewport — a saved top, or a top that was correct for the layout
// viewport, is not enough when Safari's URL bar or status bar covers it.
// Re-run on visualViewport resize and scroll so showing or hiding chrome
// moves the panel with the visible area instead of leaving the header above it.
function fitDesktopChatToViewport() {
	if (!desktopChat) return;
	if (!isNarrowDesktopChat()) {
		syncDesktopChatViewportVars(null, null);
		return;
	}
	if (desktopChat.classList.contains('dragging') || desktopChat.classList.contains('resizing')) return;
	// Keyboard up: CSS (html.gs-kb-chat) sizes the panel to the visible area;
	// don't shrink its saved size, so it comes back when the keyboard closes.
	if (_kbChat) return;
	const box = desktopChatVisibleBox();
	if (box.right - box.left < 32 || box.bottom - box.top < 32) return;
	const shift = desktopChatFixedShift();
	syncDesktopChatViewportVars(box, shift);
	if (!desktopChat.getClientRects().length) return;
	if (desktopChat.classList.contains('expanded')) return;

	const rect = desktopChat.getBoundingClientRect();
	const next = clampRectToBox(rect, box);
	if (next.width < 1 || next.height < 1) return;
	const eps = 0.5;
	if (
		Math.abs(next.left - rect.left) < eps &&
		Math.abs(next.top - rect.top) < eps &&
		Math.abs(next.width - rect.width) < eps &&
		Math.abs(next.height - rect.height) < eps
	) return;

	desktopChat.style.width = `${Math.round(next.width)}px`;
	desktopChat.style.height = `${Math.round(next.height)}px`;
	desktopChat.style.left = `${Math.round(next.left + shift.left)}px`;
	desktopChat.style.top = `${Math.round(next.top + shift.top)}px`;
	desktopChat.style.right = 'auto';
}

function scheduleFitDesktopChat() {
	if (_fitChatRaf) return;
	_fitChatRaf = requestAnimationFrame(() => {
		_fitChatRaf = 0;
		fitDesktopChatToViewport();
	});
}

function toggleDesktopChatExpanded() {
	const expanding = !desktopChat.classList.contains('expanded');
	if (expanding) {
		const rect = desktopChat.getBoundingClientRect();
		_chatSizeBeforeExpand = {
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height
		};
		desktopChat.classList.add('expanded');
		if (desktopChatExpandBtn) {
			desktopChatExpandBtn.title = 'Restore window';
			desktopChatExpandBtn.innerHTML = '&#x2750;';
		}
	} else {
		desktopChat.classList.remove('expanded');
		const s = _chatSizeBeforeExpand;
		if (s) {
			desktopChat.style.width = `${s.width}px`;
			desktopChat.style.height = `${s.height}px`;
			desktopChat.style.left = `${s.left}px`;
			desktopChat.style.top = `${s.top}px`;
			desktopChat.style.right = 'auto';
		}
		_chatSizeBeforeExpand = null;
		if (desktopChatExpandBtn) {
			desktopChatExpandBtn.title = 'Expand window';
			desktopChatExpandBtn.innerHTML = '&#x26F6;';
		}
	}
	// Sync while both states are in the DOM so expanded fills the visual
	// viewport and a restored window cannot sit under the status bar.
	fitDesktopChatToViewport();
	if (!expanding) saveDesktopChatSize();
}

restoreDesktopChatSize();
fitDesktopChatToViewport();
window.addEventListener('resize', scheduleFitDesktopChat);
window.addEventListener('orientationchange', () => {
	scheduleFitDesktopChat();
	// iOS reports the new visual viewport a beat after orientationchange.
	setTimeout(scheduleFitDesktopChat, 350);
});
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', scheduleFitDesktopChat);
	window.visualViewport.addEventListener('scroll', scheduleFitDesktopChat);
}
window.addEventListener('pageshow', scheduleFitDesktopChat);
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') scheduleFitDesktopChat();
});

// ============================================================================
// Phone layout + on-screen keyboard (phones only; desktop, tablets and VR
// never get these classes, see index.html "Phones").
// ============================================================================
// html.gs-phone   a touch screen whose short side is <= 600px.
// html.gs-kb      a text field has focus and the on-screen keyboard is (or is
//                 about to be) up. Hides the dock, Show UI, joysticks.
// html.gs-kb-chat the field is inside the GS panel: the panel fills the
//                 visible area above the keyboard (--gs-kb-*) with only the
//                 messages / editor and the input row, like a messaging app.
// The keyboard is detected from the visual viewport: Android Chrome with
// interactive-widget=resizes-content shrinks the window, iOS Safari only
// shrinks visualViewport. Both shrink visualViewport.height.
const _coarsePointer = window.matchMedia('(pointer: coarse)');
const KB_MIN_SHRINK = 120;    // px of lost height that means "keyboard up"
const KB_SETTLE_MS = 900;     // keyboard animation; after this a focused field with no shrink = no keyboard
var _phoneLayout = false;
var _kbOpen = false;
var _kbChat = false; // var: read by functions that run before this point
var _kbFocusAt = 0;
var _kbTimer = 0;
var _vvBase = { width: 0, height: 0 };

function computePhoneLayout() {
	if (!_coarsePointer.matches) return false;
	const sw = window.screen ? Math.min(window.screen.width || 0, window.screen.height || 0) : 0;
	const short = sw > 0 ? sw : Math.min(window.innerWidth, window.innerHeight);
	return short <= 600;
}
function isPhoneLayout() { return _phoneLayout; }

// The SVG menu buttons (Scenes, Export, Themes) are laid out at a fixed width
// and scaled to the panel, so on a phone a 44px row renders ~40px. Taller rows
// keep them at least 44px on screen. Desktop keeps the base height.
function phoneMenuButtonHeight(base, layoutWidth) {
	if (!computePhoneLayout()) return base;
	const short = window.screen ? Math.min(window.screen.width || 0, window.screen.height || 0) : 0;
	const panelInner = Math.max(240, (short || Math.min(window.innerWidth, window.innerHeight)) - 44);
	return Math.ceil(46 * layoutWidth / Math.min(layoutWidth, panelInner));
}

function visualViewportSize() {
	const vv = window.visualViewport;
	return {
		width: vv && vv.width > 0 ? vv.width : window.innerWidth,
		height: vv && vv.height > 0 ? vv.height : window.innerHeight,
		top: vv ? vv.offsetTop : 0,
		left: vv ? vv.offsetLeft : 0
	};
}

// Tallest visible height seen at this width = the height without a keyboard.
function updateViewportBase(v) {
	const w = Math.round(v.width);
	if (Math.abs(w - _vvBase.width) > 2) _vvBase = { width: w, height: 0 };
	const h = Math.max(v.height, _kbOpen ? 0 : window.innerHeight);
	if (h > _vvBase.height) _vvBase.height = h;
}

function keyboardTextField() {
	const el = document.activeElement;
	if (!el || !isTextEntry(el) || el.tagName === 'SELECT') return null;
	if (el.disabled || el.readOnly) return null;
	return el;
}

function syncKeyboardViewportVars(v) {
	const root = document.documentElement.style;
	if (!_kbOpen) {
		for (const n of ['--gs-kb-top', '--gs-kb-left', '--gs-kb-width', '--gs-kb-height']) root.removeProperty(n);
		return;
	}
	const safe = readSafeAreaInsets();
	const m = 4;
	// Same fixed-position correction the panel uses (iOS keeps position:fixed
	// on the layout viewport while visualViewport scrolls).
	const shift = desktopChatFixedShift();
	const top = v.top + safe.top + m;
	const left = v.left + safe.left + m;
	root.setProperty('--gs-kb-top', `${Math.round(top + (shift.top - v.top))}px`);
	root.setProperty('--gs-kb-left', `${Math.round(left + (shift.left - v.left))}px`);
	root.setProperty('--gs-kb-width', `${Math.round(Math.max(0, v.width - safe.left - safe.right - 2 * m))}px`);
	// The keyboard covers the home indicator, so no bottom safe area here.
	root.setProperty('--gs-kb-height', `${Math.round(Math.max(0, v.height - safe.top - 2 * m))}px`);
}

function chatMessagesNearBottom(el) {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}
function pinKeyboardView(force) {
	// Latest messages stay in view, and the focused field is fully visible.
	for (const id of ['desktop-chat-messages', 'dchat-theme-chat-messages']) {
		const list = document.getElementById(id);
		if (list && list.offsetParent && (force || list.dataset.gsPinned === '1')) list.scrollTop = list.scrollHeight;
	}
	const f = keyboardTextField();
	if (f && !f.closest('#desktop-chat')) f.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	else if (f && f.tagName === 'TEXTAREA' && f.id === 'dchat-code-editor') {
		// Keep the caret line inside the shrunken editor.
		const lh = parseFloat(getComputedStyle(f).lineHeight) || 20;
		const line = f.value.slice(0, f.selectionStart || 0).split('\n').length;
		const caretY = line * lh;
		if (caretY > f.scrollTop + f.clientHeight - lh) f.scrollTop = caretY - f.clientHeight + lh;
	}
}

function updateKeyboardState(reason = '') {
	const v = visualViewportSize();
	const phone = computePhoneLayout();
	if (phone !== _phoneLayout) {
		_phoneLayout = phone;
		document.documentElement.classList.toggle('gs-phone', phone);
		scheduleFitDesktopChat();
		twinSticks.place(); // the phone dock is taller
	}
	updateViewportBase(v);
	const field = phone && !document.body.classList.contains('gs-xr-presenting') && !document.body.classList.contains('gs-cardboard-active') ? keyboardTextField() : null;
	const shrink = _vvBase.height - v.height;
	let open = false;
	if (field) {
		if (shrink >= KB_MIN_SHRINK) open = true;
		else if (reason === 'focus' || reason === 'tap') { open = true; _kbFocusAt = performance.now(); }
		else open = _kbOpen && performance.now() - _kbFocusAt < KB_SETTLE_MS;
	}
	const chat = open && !!field.closest('#desktop-chat');
	const changed = open !== _kbOpen || chat !== _kbChat;
	if (changed && open) {
		for (const id of ['desktop-chat-messages', 'dchat-theme-chat-messages']) {
			const list = document.getElementById(id);
			if (list) list.dataset.gsPinned = '1';
		}
	}
	_kbOpen = open;
	_kbChat = chat;
	document.documentElement.classList.toggle('gs-kb', open);
	document.documentElement.classList.toggle('gs-kb-chat', chat);
	syncKeyboardViewportVars(v);
	if (open) pinKeyboardView(changed);
	if (changed) {
		scheduleFitDesktopChat();
		if (!open) scheduleRendererResize();
	}
	clearTimeout(_kbTimer);
	if (open && shrink < KB_MIN_SHRINK) _kbTimer = setTimeout(() => updateKeyboardState('settle'), KB_SETTLE_MS + 50);
}

function isKeyboardLayoutActive() { return _kbChat; }

document.addEventListener('focusin', () => updateKeyboardState('focus'));
document.addEventListener('focusout', () => setTimeout(() => updateKeyboardState('blur'), 150));
// Tapping a field that kept focus after the keyboard was dismissed reopens it.
document.addEventListener('pointerdown', (e) => {
	if (_phoneLayout && e.target === document.activeElement && keyboardTextField()) setTimeout(() => updateKeyboardState('tap'), 0);
}, true);
// Remember whether each chat list is scrolled to the bottom, so the keyboard
// opening or closing keeps the newest messages in view.
for (const id of ['desktop-chat-messages', 'dchat-theme-chat-messages']) {
	const list = document.getElementById(id);
	if (!list) continue;
	list.addEventListener('scroll', () => { list.dataset.gsPinned = chatMessagesNearBottom(list) ? '1' : '0'; }, { passive: true });
	new MutationObserver(() => { if (list.dataset.gsPinned !== '0') list.scrollTop = list.scrollHeight; }).observe(list, { childList: true, subtree: true });
}
// Send / More / tools: keep the field focused (keyboard stays up) on phones,
// like a messaging app. mousedown's default action is what moves focus.
for (const id of ['desktop-send-button', 'desktop-chat-more', 'dchat-theme-chat-send']) {
	const btn = document.getElementById(id);
	if (btn) btn.addEventListener('mousedown', (e) => { if (_phoneLayout && keyboardTextField()) e.preventDefault(); });
}
const _onViewportChange = () => updateKeyboardState('viewport');
window.addEventListener('resize', _onViewportChange);
window.addEventListener('orientationchange', () => setTimeout(_onViewportChange, 350));
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', _onViewportChange);
	window.visualViewport.addEventListener('scroll', _onViewportChange);
}
_coarsePointer.addEventListener?.('change', _onViewportChange);
updateKeyboardState('init');

// "More" (+) in the chat input row on phones: attach / files / mic / history.
(function initChatMoreButton() {
	const compose = document.getElementById('desktop-chat-compose-row');
	const row = document.getElementById('desktop-chat-input-row');
	if (!compose || !row || document.getElementById('desktop-chat-more')) return;
	const more = document.createElement('button');
	more.type = 'button';
	more.id = 'desktop-chat-more';
	more.title = 'More: attach, files, voice, history';
	more.setAttribute('aria-label', 'More actions');
	more.setAttribute('aria-expanded', 'false');
	more.setAttribute('aria-controls', 'desktop-chat-tools-row');
	more.textContent = '+';
	more.addEventListener('click', () => {
		const open = !row.classList.contains('gs-tools-open');
		row.classList.toggle('gs-tools-open', open);
		more.setAttribute('aria-expanded', String(open));
		more.textContent = open ? '×' : '+';
	});
	compose.insertBefore(more, compose.firstChild);
})();

// Hamburger at the top left of the menu window: toggle the vertical tab list.
// Esc or a click/ray outside the list closes it. Works on desktop, phone, and
// in the VR menu (the list is inside #desktop-chat, so htmlInCanvas paints it).
(function initTabMenu() {
	const burger = document.getElementById('gs-menu-hamburger');
	const nav = document.getElementById('gs-menu-nav');
	const tabs = document.getElementById('desktop-chat-tabs');
	if (!burger || !tabs) return;
	const toggle = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setTabMenuOpen(!isTabMenuOpen());
	};
	burger.addEventListener('click', toggle);
	const current = document.getElementById('gs-menu-current-tab');
	if (current) current.addEventListener('click', toggle);
	document.addEventListener('pointerdown', (e) => {
		if (!isTabMenuOpen()) return;
		if (e.target.closest('#desktop-chat-tabs, #gs-menu-nav')) return;
		setTabMenuOpen(false);
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && isTabMenuOpen()) {
			setTabMenuOpen(false);
			burger.focus();
		}
	});
	window.addEventListener('resize', () => { if (isTabMenuOpen()) syncTabMenuPosition(); });
	syncTabMenuPosition();
})();

// Dragging via the header, with any pointer: mouse on desktop, a finger on
// phones and tablets, a pen. Pointer Events + setPointerCapture keep tracking
// when the pointer leaves the header mid-drag (the job the document-level
// mouse listeners used to do), and the header has touch-action:none
// (index.html) so a finger drag moves the window instead of panning the page.
// Only the header is a handle: messages, tabs and fields keep scrolling and
// tapping, and the canvas keeps the camera.
// The VR mirror (html-in-canvas-source) and the phone keyboard layout
// (html.gs-kb-chat, header hidden) never start a drag.
// A drag is not saved: after any reload the window is back at its default
// spot. Only the size from resize persists (saveDesktopChatSize).
const DRAG_TOUCH_SLOP = 6;      // px a finger may wobble before a press becomes a drag

(function initDesktopChatDrag() {
	let drag = null; // { pointerId, type, startX, startY, startLeft, startTop, shiftLeft, shiftTop, phone, moved }

	function dragBox(phone) {
		if (phone) return desktopChatVisibleBox();
		// Desktop and tablets: the visible viewport (same as the window unless
		// pinch-zoomed), with no margin, as before.
		const vv = window.visualViewport;
		const w = Math.min(window.innerWidth, vv && vv.width > 0 ? vv.width : window.innerWidth);
		const h = Math.min(window.innerHeight, vv && vv.height > 0 ? vv.height : window.innerHeight);
		return { left: 0, top: 0, right: w, bottom: h };
	}

	function endDrag(e) {
		if (!drag || (e && e.pointerId !== drag.pointerId)) return;
		const d = drag;
		drag = null;
		desktopChat.classList.remove('dragging');
		try { if (desktopChatHeader.hasPointerCapture(d.pointerId)) desktopChatHeader.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
		if (d.moved) fitDesktopChatToViewport();
	}

	desktopChatHeader.addEventListener('pointerdown', (e) => {
		if (drag) return;
		if (!e.isPrimary) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if (e.target.closest('#desktop-chat-header-buttons, #gs-dock, #gs-menu-nav')) return;
		if (desktopChat.classList.contains('expanded')) return;
		if (desktopChat.classList.contains('html-in-canvas-source')) return;
		if (typeof _kbChat !== 'undefined' && _kbChat) return;
		const rect = desktopChat.getBoundingClientRect();
		const phone = isNarrowDesktopChat();
		const shift = phone ? desktopChatFixedShift() : { left: 0, top: 0 };
		drag = {
			pointerId: e.pointerId,
			type: e.pointerType || 'mouse',
			startX: e.clientX,
			startY: e.clientY,
			startLeft: rect.left,
			startTop: rect.top,
			shiftLeft: shift.left,
			shiftTop: shift.top,
			phone,
			moved: false
		};
		try { desktopChatHeader.setPointerCapture(e.pointerId); } catch { /* ignore */ }
		// No text selection / focus change from the header press.
		e.preventDefault();
	});

	desktopChatHeader.addEventListener('pointermove', (e) => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved) {
			const slop = drag.type === 'mouse' ? 0 : DRAG_TOUCH_SLOP;
			if (Math.abs(dx) <= slop && Math.abs(dy) <= slop) return;
			drag.moved = true;
			desktopChat.classList.add('dragging');
			if (drag.phone) {
				// The phone layout stretches the panel between left and right
				// insets (width:auto). Pin its size so it moves instead of
				// squeezing as left changes.
				const r = desktopChat.getBoundingClientRect();
				desktopChat.style.width = `${Math.round(r.width)}px`;
				desktopChat.style.height = `${Math.round(r.height)}px`;
				desktopChat.style.right = 'auto';
			}
		}
		const rect = desktopChat.getBoundingClientRect();
		const box = dragBox(drag.phone);
		let newLeft = drag.startLeft + dx;
		let newTop = drag.startTop + dy;
		newLeft = Math.max(box.left, Math.min(box.right - rect.width, newLeft));
		newTop = Math.max(box.top, Math.min(box.bottom - rect.height, newTop));
		desktopChat.style.left = `${Math.round(newLeft + drag.shiftLeft)}px`;
		desktopChat.style.top = `${Math.round(newTop + drag.shiftTop)}px`;
		if (e.cancelable) e.preventDefault();
	});

	desktopChatHeader.addEventListener('pointerup', (e) => endDrag(e));
	desktopChatHeader.addEventListener('pointercancel', (e) => endDrag(e));
	desktopChatHeader.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(null); });
	// The phone keyboard taking over the panel, or entering VR, ends a drag.
	window.addEventListener('blur', () => { if (drag) endDrag(null); });
})();

// Resizing via any edge or corner (hold and drag). Each handle carries a
// data-dir of which sides move: n/s/e/w or a combination for corners.
(function initDesktopChatResize() {
	const MIN_W = 280, MIN_H = 220;
	let resizing = false;
	let dir = '';
	let startX = 0, startY = 0, startWidth = 0, startHeight = 0, startLeft = 0, startTop = 0;
	let activePointerId = null;

	function onPointerDown(e) {
		if (desktopChat.classList.contains('expanded')) return;
		resizing = true;
		dir = e.currentTarget.dataset.dir;
		activePointerId = e.pointerId;
		desktopChat.classList.add('resizing');
		const rect = desktopChat.getBoundingClientRect();
		startX = e.clientX;
		startY = e.clientY;
		startWidth = rect.width;
		startHeight = rect.height;
		startLeft = rect.left;
		startTop = rect.top;
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
		e.preventDefault();
	}

	function onPointerMove(e) {
		if (!resizing) return;
		if (activePointerId != null && e.pointerId !== activePointerId) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		const phone = isNarrowDesktopChat();
		const box = phone ? desktopChatVisibleBox() : null;
		const minW = phone ? Math.min(MIN_W, Math.max(120, box.right - box.left)) : MIN_W;
		const minH = phone ? Math.min(MIN_H, Math.max(120, box.bottom - box.top)) : MIN_H;
		const shift = phone ? desktopChatFixedShift() : null;

		if (dir.includes('e')) {
			const limit = phone ? box.right - startLeft : window.innerWidth - startLeft - 8;
			const newWidth = Math.max(minW, Math.min(limit, startWidth + dx));
			desktopChat.style.width = `${newWidth}px`;
		}
		if (dir.includes('s')) {
			const limit = phone ? box.bottom - startTop : window.innerHeight - startTop - 8;
			const newHeight = Math.max(minH, Math.min(limit, startHeight + dy));
			desktopChat.style.height = `${newHeight}px`;
		}
		if (dir.includes('w')) {
			const maxDx = startWidth - minW;
			const minDx = phone ? box.left - startLeft : -startLeft;
			const clampedDx = Math.max(minDx, Math.min(maxDx, dx));
			desktopChat.style.width = `${startWidth - clampedDx}px`;
			const left = startLeft + clampedDx;
			desktopChat.style.left = `${phone ? left + shift.left : left}px`;
		}
		if (dir.includes('n')) {
			const maxDy = startHeight - minH;
			const minDy = phone ? box.top - startTop : -startTop;
			const clampedDy = Math.max(minDy, Math.min(maxDy, dy));
			desktopChat.style.height = `${startHeight - clampedDy}px`;
			const top = startTop + clampedDy;
			desktopChat.style.top = `${phone ? top + shift.top : top}px`;
		}
	}

	function onPointerUp(e) {
		if (!resizing) return;
		if (activePointerId != null && e.pointerId !== activePointerId) return;
		resizing = false;
		dir = '';
		activePointerId = null;
		desktopChat.classList.remove('resizing');
		fitDesktopChatToViewport();
		saveDesktopChatSize();
	}

	document.querySelectorAll('.dchat-resize').forEach(handle => {
		handle.addEventListener('pointerdown', onPointerDown);
		handle.addEventListener('pointermove', onPointerMove);
		handle.addEventListener('pointerup', onPointerUp);
		handle.addEventListener('pointercancel', onPointerUp);
	});
})();

// Ctrl+Arrow snaps the chat window to the nearest screen edge (or corner
// with a diagonal-feeling combo: press twice, once per axis). Only active
// when not immersive and not typing in a text field.
document.addEventListener('keydown', (e) => {
	if (!e.ctrlKey) return;
	const arrowDirs = { ArrowLeft: 'w', ArrowRight: 'e', ArrowUp: 'n', ArrowDown: 's' };
	const dir = arrowDirs[e.key];
	if (!dir) return;
	if (desktopChat.classList.contains('hidden')) return;
	if (renderer.xr.isPresenting) return;
	const activeTag = document.activeElement && document.activeElement.tagName;
	if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

	e.preventDefault();
	const rect = desktopChat.getBoundingClientRect();
	const margin = 8;
	const phone = isNarrowDesktopChat();
	const box = phone ? desktopChatVisibleBox() : null;
	const shift = phone ? desktopChatFixedShift() : null;
	let left = rect.left, top = rect.top;
	if (dir === 'w') left = phone ? box.left : margin;
	if (dir === 'e') left = phone ? box.right - rect.width : window.innerWidth - rect.width - margin;
	if (dir === 'n') top = phone ? box.top : margin;
	if (dir === 's') top = phone ? box.bottom - rect.height : window.innerHeight - rect.height - margin;
	desktopChat.style.left = `${phone ? left + shift.left : left}px`;
	desktopChat.style.top = `${phone ? top + shift.top : top}px`;
	if (phone) fitDesktopChatToViewport();
});

// Tabs: opened from the hamburger at the top left of the menu window
// (Chat / Environment / Scenes / Files / Code / Community / Controls /
// Dependencies / Share & Export / Render / Technical / Meta Settings).
function tabButtonLabel(btn) {
	if (!btn) return '';
	const clone = btn.cloneNode(true);
	clone.querySelectorAll('.dchat-tab-short').forEach((el) => el.remove());
	return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}
function syncCurrentTabLabel() {
	const label = document.getElementById('gs-menu-current-tab');
	const active = document.querySelector('.dchat-tab.active');
	if (label && active) label.textContent = tabButtonLabel(active);
}
function isTabMenuOpen() {
	return !!(desktopChat && desktopChat.classList.contains('gs-tab-menu-open'));
}
function syncTabMenuPosition() {
	if (!desktopChat || !desktopChatHeader) return;
	desktopChat.style.setProperty('--gs-header-h', `${desktopChatHeader.offsetHeight}px`);
}
function setTabMenuOpen(open) {
	if (!desktopChat) return;
	desktopChat.classList.toggle('gs-tab-menu-open', !!open);
	const burger = document.getElementById('gs-menu-hamburger');
	if (burger) {
		burger.setAttribute('aria-expanded', String(!!open));
		burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
		burger.title = open ? 'Close menu' : 'Open menu';
	}
	if (open) {
		syncTabMenuPosition();
		document.querySelector('.dchat-tab.active')?.scrollIntoView({ block: 'nearest' });
	}
}
function activateTab(name) {
	const tab = document.querySelector(`.dchat-tab[data-tab="${name}"]`);
	if (!tab) return false;
	document.querySelectorAll('.dchat-tab').forEach((t) => t.classList.remove('active'));
	document.querySelectorAll('.dchat-panel').forEach((p) => p.classList.remove('active'));
	tab.classList.add('active');
	const panel = document.getElementById(`dchat-panel-${tab.dataset.tab}`);
	if (panel) panel.classList.add('active');
	if (tab.dataset.tab === 'community') setCommunitySection(communitySection);
	if (tab.dataset.tab === 'code') syncCodeEditorFromState({ force: false });
	syncCurrentTabLabel();
	setTabMenuOpen(false);
	return true;
}
window.gsSelectTab = activateTab;

document.querySelectorAll('.dchat-tab').forEach((tab) => {
	tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});
syncCurrentTabLabel();

// Code tab: edit generated VR program with optional live re-apply.
if (dchatCodeEditor) {
	dchatCodeEditor.addEventListener('input', markCodeEditorDirty);
	dchatCodeEditor.addEventListener('keydown', (e) => {
		// Keep Tab inserting spaces inside the editor instead of leaving the field.
		if (e.key === 'Tab') {
			e.preventDefault();
			const start = dchatCodeEditor.selectionStart;
			const end = dchatCodeEditor.selectionEnd;
			const v = dchatCodeEditor.value;
			dchatCodeEditor.value = v.slice(0, start) + '	' + v.slice(end);
			dchatCodeEditor.selectionStart = dchatCodeEditor.selectionEnd = start + 1;
			codeHighlightApi?.refresh();
			markCodeEditorDirty();
		}
	});
}
if (dchatCodeApply) dchatCodeApply.addEventListener('click', () => hotReloadFromEditor());
const dchatCodeReset = document.getElementById('dchat-code-reset');
if (dchatCodeReset) dchatCodeReset.addEventListener('click', () => applyCodeFromEditor());
if (dchatCodeRevert) dchatCodeRevert.addEventListener('click', revertCodeEditor);
if (dchatCodeLive) {
	dchatCodeLive.checked = false; // default OFF for safety
	dchatCodeLive.addEventListener('change', () => {
		if (dchatCodeLive.checked && codeEditorDirty) scheduleLiveCodeApply();
	});
}
syncCodeEditorFromState({ force: true });

document.querySelectorAll('#dchat-community-subtabs .dchat-subtab').forEach(btn => {
	btn.addEventListener('click', () => setCommunitySection(btn.dataset.communitySection));
});
document.querySelectorAll('#dchat-chat-subtabs .dchat-subtab').forEach(btn => {
	btn.addEventListener('click', () => setChatSection(btn.dataset.chatSection));
});
// Chat → Prompt editor (chatPrompt.js). In VR the same DOM view is painted
// into the menu window, so there is nothing extra to redraw here.
window.GSChatPrompt = ChatPrompt; // console / test access
// Console / test access.
window.gsChatPanel = {
	get section() { return chatSection; },
	action: (a) => handleMenuAction(a),
	simulateHeadset: false
};
ChatPrompt.initPromptEditor({
	onOpenPrompt: () => setChatSection('prompt'),
	onStatus: (t) => updateStatus(t, 'connected')
});

syncRememberThemeCheckboxes();
if (dchatThemeRemember) {
	dchatThemeRemember.addEventListener('change', () => setRememberTheme(dchatThemeRemember.checked));
}
if (dchatThemeRememberCommunity) {
	dchatThemeRememberCommunity.addEventListener('change', () => setRememberTheme(dchatThemeRememberCommunity.checked));
}
if (dchatThemeChatSend) dchatThemeChatSend.addEventListener('click', sendThemeChat);
if (dchatThemeChatInput) initChatTextarea(dchatThemeChatInput, () => sendThemeChat());


// ============================================================================
// 360 / HDRI environment (Environment tab)
// ============================================================================
function setHdriStatus(text, kind) {
	if (!dchatHdriStatus) return;
	dchatHdriStatus.textContent = text || '';
	dchatHdriStatus.style.color = kind === 'error' ? '#f87171'
		: kind === 'ok' ? '#34d399'
		: 'rgba(255,255,255,0.4)';
}

function getPmremGenerator() {
	if (!pmremGenerator) {
		pmremGenerator = new THREE.PMREMGenerator(renderer);
		pmremGenerator.compileEquirectangularShader();
	}
	return pmremGenerator;
}

function disposeHdriTextures({ revokeBlob = true } = {}) {
	if (scene.environment === hdriPMREM) scene.environment = null;
	if (scene.background === hdriEquirect) scene.background = null;
	if (hdriPMREM) { hdriPMREM.dispose(); hdriPMREM = null; }
	if (hdriEquirect) { hdriEquirect.dispose(); hdriEquirect = null; }
	if (revokeBlob && hdriObjectUrl) {
		URL.revokeObjectURL(hdriObjectUrl);
		hdriObjectUrl = null;
	}
}

function clearHdriEnvironment() {
	hdriApplySeq += 1; // drop any HDRI still loading
	disposeHdriTextures({ revokeBlob: true });
	hdriPersistUrl = null;
	hdriCurrentUrl = null;
	hdriFormat = null;
	hdriLocalFile = null;
	hdriSceneDesc = null;
	try { localStorage.removeItem(HDRI_URL_STORAGE_KEY); } catch { /* ignore */ }
	applyEnvironmentMode();
	setHdriStatus('Cleared', '');
}

async function loadHdriTextureFromUrl(url, format = hdriFormatFromName(url)) {
	if (format === 'hdr') return new HDRLoader().loadAsync(url);
	if (format === 'exr') return new EXRLoader().loadAsync(url);
	return new THREE.TextureLoader().loadAsync(url);
}

/**
 * Load an equirect HDRI / 360 image as scene.environment (+ background).
 * - persist: remember an http(s) URL in localStorage (the user's own choice)
 * - objectUrl + file: a file picked from this computer
 * - fromScene: the environmentHdri of the scene that asked for it (not
 *   remembered as the user's default; see applySceneEnvironmentHdri)
 * Resolves true when this HDRI is now active.
 */
async function applyHdriFromUrl(url, { persist = false, objectUrl = null, file = null, format = null, fromScene = null } = {}) {
	if (!url) return false;
	const seq = ++hdriApplySeq;
	const fmt = format || (file ? hdriFormatFromName(file.name) : hdriFormatFromName(url));
	setHdriStatus('Loading…', 'pending');
	try {
		const tex = await loadHdriTextureFromUrl(url, fmt);
		if (seq !== hdriApplySeq) { tex.dispose(); return false; } // a newer HDRI (or Clear) won
		tex.mapping = THREE.EquirectangularReflectionMapping;
		const isHdr = fmt === 'hdr' || fmt === 'exr';
		tex.colorSpace = isHdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
		tex.needsUpdate = true;

		const envRT = getPmremGenerator().fromEquirectangular(tex);
		disposeHdriTextures({ revokeBlob: !objectUrl });
		if (objectUrl) hdriObjectUrl = objectUrl;

		hdriEquirect = tex;
		hdriPMREM = envRT.texture;
		scene.environment = hdriPMREM;
		hdriUseAsBackground = !!(dchatHdriBg ? dchatHdriBg.checked : true);
		applyEnvironmentMode();

		hdriFormat = fmt;
		hdriLocalFile = objectUrl ? file : null;
		hdriCurrentUrl = objectUrl ? null : url;
		hdriSceneDesc = fromScene || null;
		if (persist && !fromScene && /^https?:\/\//i.test(url)) {
			hdriPersistUrl = url;
			try { localStorage.setItem(HDRI_URL_STORAGE_KEY, url); } catch { /* ignore */ }
		} else if (objectUrl) {
			hdriPersistUrl = null;
		} else {
			hdriPersistUrl = /^https?:\/\//i.test(url) ? url : null;
		}
		setHdriStatus(fromScene ? 'Loaded from the scene (kept with it when shared)'
			: hdriLocalFile ? 'Loaded (local file — uploaded with Community scenes)'
			: hdriPersistUrl ? 'Loaded (URL kept for reload)' : 'Loaded', 'ok');
		return true;
	} catch (err) {
		if (seq !== hdriApplySeq) return false;
		console.error('HDRI load failed:', err);
		setHdriStatus('Error: ' + (err && err.message ? err.message : err), 'error');
		return false;
	}
}

/** environmentHdri for the current HDRI, or null. A file picked from this
 *  computer only exists here, so it is described only for a Community
 *  upload (`forUpload`), which then sends the bytes too. */
function currentEnvironmentHdri({ forUpload = false } = {}) {
	if (!hdriEquirect) return null;
	const background = !!hdriUseAsBackground;
	if (hdriLocalFile) {
		if (!forUpload) return null;
		return normalizeEnvironmentHdri({ kind: 'file', name: hdriLocalFile.name, size: hdriLocalFile.size, format: hdriFormat, background });
	}
	if (!hdriCurrentUrl) return null;
	return normalizeEnvironmentHdri({ kind: 'url', url: hdriCurrentUrl, format: hdriFormat, background });
}

function environmentHdriForScene() {
	const desc = currentEnvironmentHdri();
	return desc ? { environmentHdri: desc } : {};
}

/** Signature of the current HDRI for "unchanged since shared?" checks. */
function hdriShareSig() {
	return environmentHdriSignature(currentEnvironmentHdri({ forUpload: true }));
}

/** { desc, file } when the active HDRI is a local file that fits a Community
 *  upload, else null (an oversized file is left out with a note). */
function hdriFileForUpload() {
	if (!hdriEquirect || !hdriLocalFile) return null;
	if (hdriLocalFile.size > HDRI_FILE_MAX_BYTES) {
		setHdriStatus(`Local HDRI is over ${Math.round(HDRI_FILE_MAX_BYTES / (1024 * 1024))} MB, so Community uploads use the default environment`, 'error');
		return null;
	}
	return { desc: currentEnvironmentHdri({ forUpload: true }), file: hdriLocalFile };
}

/** PUT the custom HDRI bytes for a just-uploaded scene. Resolves '' on
 *  success, else a short note for the status line. */
async function uploadSceneHdriFile(sceneId, file) {
	const url = `/api/community-scenes/${encodeURIComponent(sceneId)}/hdri`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetch(url, {
				method: 'PUT',
				headers: { 'Content-Type': file.type || 'application/octet-stream' },
				body: file
			});
			if (res.ok) return '';
			if (res.status === 413) return ` (HDRI "${file.name}" is too large for this server, so the scene opens with the default environment)`;
			if (res.status !== 404) {
				let msg = `HTTP ${res.status}`;
				try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
				return ` (HDRI not saved: ${msg})`;
			}
		} catch (err) {
			if (attempt) return ` (HDRI not saved: ${err.message})`;
		}
		await new Promise(r => setTimeout(r, 1500)); // a just-written scene may not be listed yet
	}
	return ' (HDRI not saved)';
}

/** Put back the user's own HDRI (their remembered URL, or none) after a
 *  scene-supplied one. */
function restoreUserHdri() {
	hdriSceneDesc = null;
	let saved = null;
	try { saved = localStorage.getItem(HDRI_URL_STORAGE_KEY); } catch { /* ignore */ }
	if (saved && /^https?:\/\//i.test(saved)) {
		if (dchatHdriUrl) dchatHdriUrl.value = saved;
		return applyHdriFromUrl(saved, { persist: true });
	}
	hdriApplySeq += 1;
	disposeHdriTextures({ revokeBlob: true });
	hdriPersistUrl = null;
	hdriCurrentUrl = null;
	hdriFormat = null;
	hdriLocalFile = null;
	applyEnvironmentMode();
	setHdriStatus('', '');
	return Promise.resolve(true);
}

/**
 * A loaded scene brings its environment HDRI. Scenes without
 * environmentHdri (saved before it existed, or with no HDRI) keep the viewer's own
 * environment; one left behind by a previous scene is replaced by it.
 * Resolves '' or a short note when the scene's HDRI could not be loaded.
 */
function applySceneEnvironmentHdri(data) {
	const desc = normalizeEnvironmentHdri(data && data.environmentHdri);
	const url = environmentHdriLoadUrl(desc);
	if (!desc || !url) {
		if (hdriSceneDesc) restoreUserHdri();
		return Promise.resolve('');
	}
	const prevBackground = hdriUseAsBackground;
	if (dchatHdriBg) dchatHdriBg.checked = desc.background;
	hdriUseAsBackground = desc.background;
	if (hdriEquirect && hdriCurrentUrl === url) {
		// Already showing it; just follow the scene's background choice.
		hdriSceneDesc = hdriSceneDesc || desc;
		applyEnvironmentMode();
		return Promise.resolve('');
	}
	if (dchatHdriUrl && desc.kind === 'url') dchatHdriUrl.value = url;
	return applyHdriFromUrl(url, { format: desc.format, fromScene: desc }).then((ok) => {
		if (ok) return '';
		if (dchatHdriBg) dchatHdriBg.checked = prevBackground;
		hdriUseAsBackground = prevBackground;
		if (hdriSceneDesc) restoreUserHdri();
		else applyEnvironmentMode();
		return ' (its HDRI could not be loaded, so the default environment is used)';
	});
}

// ============================================================================
// GS version badge + picker (Meta Settings tab)
// ============================================================================
function initGsVersionPicker() {
	const btn = document.getElementById('gs-version-btn');
	const modal = document.getElementById('gs-version-modal');
	const listEl = document.getElementById('gs-version-list');
	const closeBtn = document.getElementById('gs-version-close');
	if (!btn || !modal || !listEl) return;

	btn.innerHTML = '';
	const prefix = document.createElement('span');
	prefix.className = 'gs-dock-prefix';
	prefix.textContent = 'GS ';
	btn.append(prefix, `v${GS_VERSION}`);
	btn.setAttribute('aria-label', `GS version ${GS_VERSION}. Choose version.`);

	let versions = mergeVersionList(null);
	let loading = false;

	function hide() {
		modal.classList.remove('visible');
		modal.setAttribute('aria-hidden', 'true');
	}

	function show() {
		modal.classList.add('visible');
		modal.setAttribute('aria-hidden', 'false');
		// Open at the top so the newest changelog entry is what you see first.
		closeBtn?.focus({ preventScroll: true });
		const inner = document.getElementById('gs-version-modal-inner');
		if (inner) inner.scrollTop = 0;
	}

	function renderList() {
		listEl.innerHTML = '';
		for (const entry of versions) {
			// One card per version: the open/switch row, then its changelog.
			const item = document.createElement('div');
			item.className = 'gs-version-item';
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'gs-version-row';
			const current = isCurrentVersionEntry(entry);
			if (current) row.classList.add('current');
			const label = document.createElement('span');
			label.textContent = entry.label || `GS ${entry.id}`;
			const meta = document.createElement('span');
			meta.className = 'gs-version-meta';
			meta.textContent = [entry.date, current ? 'Current' : (entry.url ? 'Open' : entry.id)].filter(Boolean).join(' · ');
			row.appendChild(label);
			row.appendChild(meta);
			item.appendChild(row);
			if (entry.changes?.length) {
				const ul = document.createElement('ul');
				ul.className = 'gs-version-changes';
				for (const change of entry.changes) {
					const li = document.createElement('li');
					li.textContent = change;
					ul.appendChild(li);
				}
				item.appendChild(ul);
			}
			row.addEventListener('click', () => {
				if (current || entry.url == null || entry.url === '') {
					hide();
					return;
				}
				try {
					const target = new URL(entry.url, location.href);
					if (target.href === location.href) {
						hide();
						return;
					}
					location.assign(target.href);
				} catch (err) {
					console.warn('[gs] bad version url', entry, err);
					updateStatus(`Invalid version URL for ${entry.id}`, 'error');
				}
			});
			listEl.appendChild(item);
		}
	}

	async function refreshVersions() {
		if (loading) return;
		loading = true;
		try {
			const manifest = await loadVersionManifest();
			versions = mergeVersionList(manifest);
		} catch (err) {
			console.warn('[gs] versions.json load failed', err);
			versions = mergeVersionList(null);
		} finally {
			loading = false;
			renderList();
		}
	}

	btn.addEventListener('click', () => {
		show();
		refreshVersions();
		renderList();
	});
	closeBtn?.addEventListener('click', hide);
	modal.addEventListener('click', (e) => {
		if (e.target === modal) hide();
	});
	window.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && modal.classList.contains('visible')) hide();
	});

	renderList();
	refreshVersions();
}

function initHdriControls() {
	if (dchatHdriBg) {
		hdriUseAsBackground = dchatHdriBg.checked;
		dchatHdriBg.addEventListener('change', () => {
			hdriUseAsBackground = dchatHdriBg.checked;
			applyEnvironmentMode();
		});
	}
	if (dchatHdriPick && dchatHdriFile) {
		dchatHdriPick.addEventListener('click', () => dchatHdriFile.click());
		dchatHdriFile.addEventListener('change', async () => {
			const file = dchatHdriFile.files && dchatHdriFile.files[0];
			dchatHdriFile.value = '';
			if (!file) return;
			const obj = URL.createObjectURL(file);
			await applyHdriFromUrl(obj, { persist: false, objectUrl: obj, file });
		});
	}
	if (dchatHdriUrlLoad && dchatHdriUrl) {
		dchatHdriUrlLoad.addEventListener('click', () => {
			const u = (dchatHdriUrl.value || '').trim();
			if (!u) { setHdriStatus('Enter a URL', 'error'); return; }
			applyHdriFromUrl(u, { persist: true });
		});
		dchatHdriUrl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				dchatHdriUrlLoad.click();
			}
		});
	}
	if (dchatHdriClear) dchatHdriClear.addEventListener('click', clearHdriEnvironment);

	try {
		const saved = localStorage.getItem(HDRI_URL_STORAGE_KEY);
		if (saved && /^https?:\/\//i.test(saved)) {
			if (dchatHdriUrl) dchatHdriUrl.value = saved;
			applyHdriFromUrl(saved, { persist: true });
		}
	} catch { /* ignore */ }
}

initHdriControls();
initGsVersionPicker();

if (dchatCodeEditor && dchatCodeHighlight) {
	codeHighlightApi = mountCodeHighlight(dchatCodeEditor, dchatCodeHighlight);
}

// Environment tab: VR mode (shared button spec, see ENV_MODE_BUTTONS/
// handleMenuAction) and the "Select Color" bar (native color input overlaid
// on the active-color preview). The toggle buttons themselves are
// (re)mounted by renderDomEnv() since their active/inactive styling depends
// on isVRMode.
dchatColorPicker.addEventListener('input', () => {
	const hex = dchatColorPicker.value;
	const c = new THREE.Color(hex);
	const hsl = { h: 0, s: 0, l: 0 };
	c.getHSL(hsl);
	vrBgHue = hsl.h * 360;
	vrBgSat = hsl.s;
	vrBgLight = hsl.l;
	applyEnvironmentMode();
	renderDomEnv();
});
dchatResetCameraBtn.addEventListener('click', resetCameraView);

// Scenes / Community tabs: shared button specs (SCENES_BUTTONS,
// COMMUNITY_BUTTONS) mounted once as HTML buttons - their content never
// changes. HTML (not SVG) lets the long Scenes labels wrap on a phone, and
// htmlInCanvas / vrWindows still paints the same DOM into the VR menu.
mountHtmlActionButtons(dchatScenesButtonsMount, SCENES_BUTTONS);
renderCommunityDesktopButtons();
if (dchatThemesButtonsMount) {
	mountButtonsToDOM(dchatThemesButtonsMount, THEME_BUTTONS, { width: 384, height: phoneMenuButtonHeight(44, 384), gap: 8, perRow: 3, fontSize: 11 }, handleMenuAction);
}

function xrSessionActive() {
	return !!(renderer && renderer.xr && renderer.xr.isPresenting);
}

// One place for VR window visibility so collapsing the UI, display-only shares
// and the keyboard cannot disagree. In a headset the menu is #desktop-chat painted
// into the world (vrWindows.js); outside XR it is the on-screen window.
function applyXrPanelVisibility(immersive = xrSessionActive()) {
	const show = immersive && !uiCollapsed && !displayOnlyMode;
	if (vrMainWindow) vrMainWindow.setVisible(show);
	if (vrKeyboardWindow) vrKeyboardWindow.setVisible(show && vrKeyboardOpen);
	if (vrHudWindow) vrHudWindow.setVisible(immersive && !displayOnlyMode);
	if (!immersive && vrKeyboardOpen) closeVrKeyboard({ apply: false });
	syncVrMenuLight();

	if (desktopChat) {
		const hideDom = displayOnlyMode || (immersive ? !show : uiCollapsed);
		desktopChat.classList.toggle('hidden', hideDom);
	}
	// The slim dom-overlay bar is never used: the menu window has the chat field.
	if (chatOverlayBar) chatOverlayBar.classList.remove('visible');
}

function setImmersiveUiMode(immersive) {
	// The head-locked hud (Hide/Show-UI window) only makes sense with a headset;
	// the desktop equivalent is the #ui-toggle Show UI button after minimize.
	hud.visible = immersive && !displayOnlyMode;
	// Mouse orbit/pan/zoom only makes sense windowed — the headset pose drives
	// the camera during an XR session.
	refreshCameraControls();
	if (immersive) cameraControls.unlock();
	document.body.classList.toggle('gs-xr-presenting', !!immersive);
	applyXrPanelVisibility(immersive);
}

// ============================================================================
// Window Resize
// ============================================================================
// The canvas must always fill the visible page: pinch-zoom, browser zoom,
// orientation, window resize, iOS Safari toolbar show/hide, and
// devicePixelRatio changes. Size comes from the live layout (canvas client
// box, visualViewport, innerWidth/innerHeight) rather than cached values.
// Skip while WebXR is presenting — three.js owns the buffer then.
const MAX_PIXEL_RATIO = 3;
var _rendererSize = { w: window.innerWidth, h: window.innerHeight };
var _rendererResizeRaf = 0;

function rendererPixelRatio() {
	return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

function visibleViewportSize() {
	const vv = window.visualViewport;
	const iw = window.innerWidth || 0;
	const ih = window.innerHeight || 0;
	const vw = vv && vv.width > 0 ? vv.width : 0;
	const vh = vv && vv.height > 0 ? vv.height : 0;
	// Pinch-zoom out can make the visual viewport larger than the layout one.
	return {
		w: Math.max(1, Math.round(Math.max(iw, vw))),
		h: Math.max(1, Math.round(Math.max(ih, vh)))
	};
}

function applyRendererSize() {
	_rendererResizeRaf = 0;
	if (renderer.xr.isPresenting) return;
	const canvas = renderer.domElement;
	const vis = visibleViewportSize();
	// If CSS has not filled the visible page (older browsers, leftover inline
	// sizes), force the CSS box to the visible viewport.
	if (canvas.clientWidth + 1 < vis.w || canvas.clientHeight + 1 < vis.h) {
		canvas.style.width = vis.w + 'px';
		canvas.style.height = vis.h + 'px';
	}
	const w = Math.max(vis.w, Math.round(canvas.clientWidth || vis.w));
	const h = Math.max(vis.h, Math.round(canvas.clientHeight || vis.h));
	// While the phone keyboard is up (Android shrinks the window), keep the
	// canvas at its full size: it sits behind the panel, and resizing it on
	// every keyboard animation frame just thrashes WebGL.
	if (isKeyboardLayoutActive() && w === _rendererSize.w) return;
	const px = rendererPixelRatio();
	if (w === _rendererSize.w && h === _rendererSize.h && canvas.width) {
		if (Math.round(w * px) === canvas.width && Math.round(h * px) === canvas.height) return;
	}
	_rendererSize = { w, h };
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	if (renderer.getPixelRatio() !== px) renderer.setPixelRatio(px);
	renderer.setSize(w, h, false);
}

function scheduleRendererResize() {
	if (_rendererResizeRaf) return;
	_rendererResizeRaf = requestAnimationFrame(applyRendererSize);
}

function onWindowResize() {
	scheduleRendererResize();
}

window.addEventListener('resize', onWindowResize);
window.addEventListener('orientationchange', () => {
	scheduleRendererResize();
	// iOS often fires this before the new layout size is available.
	setTimeout(scheduleRendererResize, 200);
	setTimeout(scheduleRendererResize, 500);
});
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', scheduleRendererResize);
	window.visualViewport.addEventListener('scroll', scheduleRendererResize);
}
if (typeof ResizeObserver === 'function') {
	const ro = new ResizeObserver(() => scheduleRendererResize());
	ro.observe(document.documentElement);
	if (appElement) ro.observe(appElement);
}
(function watchDevicePixelRatio() {
	let mql;
	const onChange = () => {
		scheduleRendererResize();
		attach();
	};
	const attach = () => {
		if (mql) {
			if (mql.removeEventListener) mql.removeEventListener('change', onChange);
			else if (mql.removeListener) mql.removeListener(onChange);
		}
		try { mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`); }
		catch { mql = null; return; }
		if (!mql) return;
		if (mql.addEventListener) mql.addEventListener('change', onChange);
		else if (mql.addListener) mql.addListener(onChange);
	};
	attach();
})();
applyRendererSize();

renderer.xr.addEventListener('sessionstart', () => {
	// 'local-floor' reference space: origin at the real floor, eye level
	// is around y=1.6, so the menu sits just below eye level for comfort.
	layoutVrWindows();
	resetPanelAnchor();
	if (windowAnchorMode === 'follow') _anchorSnapNext = true; // start right in front of you
	setImmersiveUiMode(true);

	// immersive-ar starts on the room (passthrough); immersive-vr on the
	// colour skybox. "VR (color)" in the Environment tab covers the room in AR.
	isVRMode = xrSessionMode !== 'immersive-ar';
	document.body.classList.toggle('gs-xr-ar', xrSessionMode === 'immersive-ar');
	applyEnvironmentMode();
	renderDomEnv();
	renderXrModeToggle();
	// An open camera preview switches to the headset (passthrough) camera.
	photoCapture?.restartForMode();
});

renderer.xr.addEventListener('sessionend', () => {
	endVrGizmoGrab();
	resetPanelAnchor();
	xrSessionMode = null;
	document.body.classList.remove('gs-xr-ar');
	isVRMode = true;
	applyEnvironmentMode();
	renderDomEnv();
	renderXrModeToggle();
	setImmersiveUiMode(false);
	resetCameraView(); // back to the default desktop view (not the headset pose)
	photoCapture?.restartForMode();
	scheduleRendererResize();
});

// ============================================================================
// Window anchoring — Fixed (in the world) or Follow head (lazy, yaw-only)
// ============================================================================
// The world VR windows (menu and keyboard) are children of panelAnchor,
// positioned by layoutVrWindows() in its local space. In
// Fixed mode the anchor is the identity, so nothing changes. In Follow mode
// the anchor glides to the head's position and heading, but only once the
// windows drift out of a comfort zone (turned away > 50 degrees, walked > 0.4 m
// or head height changed > 0.3 m), then eases in and stops. Yaw only, so the
// windows stay upright. Per frame it is a handful of vector ops and no
// allocations; raycasts use the updated matrices, so buttons keep working
// while the windows move.
const WINDOW_ANCHOR_STORAGE_KEY = 'gs.windowAnchor';
const WINDOW_ANCHOR_MODES = ['fixed', 'follow'];
const FOLLOW_EYE_HEIGHT = 1.6;               // panel layout assumes eyes at 1.6 m (panels at 1.4 m)
const FOLLOW_YAW_START = THREE.MathUtils.degToRad(50);
const FOLLOW_YAW_STOP = THREE.MathUtils.degToRad(1);
const FOLLOW_DIST_START = 0.4;
const FOLLOW_HEIGHT_START = 0.3;
const FOLLOW_STOP_DIST = 0.02;
const FOLLOW_RATE = 4;                       // 1/s exponential ease
let windowAnchorMode = 'fixed';
let _anchorFollowing = false;
let _anchorSnapNext = false;
let _anchorYaw = 0;
const panelAnchor = new THREE.Group();
panelAnchor.name = 'gsPanelAnchor';
scene.add(panelAnchor);
const _anchorHeadPos = new THREE.Vector3();
const _anchorHeadDir = new THREE.Vector3();

function resetPanelAnchor() {
	panelAnchor.position.set(0, 0, 0);
	panelAnchor.rotation.set(0, 0, 0);
	_anchorYaw = 0;
	_anchorFollowing = false;
	panelAnchor.updateMatrixWorld(true);
}

function wrapAngle(a) {
	while (a > Math.PI) a -= Math.PI * 2;
	while (a < -Math.PI) a += Math.PI * 2;
	return a;
}

// Called once per XR frame before the panel billboarding and raycasts.
function updatePanelAnchor(dt, xrCamera) {
	if (windowAnchorMode !== 'follow') return;
	// Don't slide a window out from under an active trigger drag.
	if (vrWindows && vrWindows.anyDragging()) return;
	xrCamera.getWorldPosition(_anchorHeadPos);
	xrCamera.getWorldDirection(_anchorHeadDir);
	const horiz = Math.hypot(_anchorHeadDir.x, _anchorHeadDir.z);
	// Looking straight up/down: heading is undefined, keep the current one.
	const headYaw = horiz > 0.2 ? Math.atan2(-_anchorHeadDir.x, -_anchorHeadDir.z) : _anchorYaw;
	const tx = _anchorHeadPos.x;
	const ty = _anchorHeadPos.y - FOLLOW_EYE_HEIGHT;
	const tz = _anchorHeadPos.z;
	const p = panelAnchor.position;
	const dYaw = wrapAngle(headYaw - _anchorYaw);
	const dist = Math.hypot(tx - p.x, tz - p.z);
	const dy = ty - p.y;
	if (_anchorSnapNext) {
		_anchorSnapNext = false;
		p.set(tx, ty, tz);
		_anchorYaw = headYaw;
		_anchorFollowing = false;
	} else {
		if (!_anchorFollowing && (Math.abs(dYaw) > FOLLOW_YAW_START || dist > FOLLOW_DIST_START || Math.abs(dy) > FOLLOW_HEIGHT_START)) {
			_anchorFollowing = true;
		}
		if (!_anchorFollowing) return;
		const k = 1 - Math.exp(-FOLLOW_RATE * Math.max(dt, 1 / 120));
		p.x += (tx - p.x) * k;
		p.y += dy * k;
		p.z += (tz - p.z) * k;
		_anchorYaw = wrapAngle(_anchorYaw + dYaw * k);
		if (Math.abs(dYaw) < FOLLOW_YAW_STOP && dist < FOLLOW_STOP_DIST && Math.abs(dy) < FOLLOW_STOP_DIST) {
			_anchorFollowing = false;
		}
	}
	panelAnchor.rotation.set(0, _anchorYaw, 0);
	panelAnchor.updateMatrixWorld(true);
}

function renderWindowAnchorUi() {
	document.querySelectorAll('#dchat-window-anchor [data-window-anchor]').forEach((btn) => {
		const on = btn.dataset.windowAnchor === windowAnchorMode;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
}

function setWindowAnchorMode(mode, { persist = true } = {}) {
	if (!WINDOW_ANCHOR_MODES.includes(mode)) mode = 'fixed';
	windowAnchorMode = mode;
	if (mode === 'fixed') {
		resetPanelAnchor();
	} else if (xrSessionActive()) {
		// Glide in from wherever the windows are now.
		_anchorFollowing = true;
	}
	if (persist) {
		try { localStorage.setItem(WINDOW_ANCHOR_STORAGE_KEY, mode); } catch { /* storage blocked */ }
	}
	renderWindowAnchorUi();
	renderDomEnv();
	updateStatus(mode === 'follow' ? 'Windows follow your head' : 'Windows fixed in place', '');
}

document.querySelectorAll('#dchat-window-anchor [data-window-anchor]').forEach((btn) => {
	btn.addEventListener('click', () => setWindowAnchorMode(btn.dataset.windowAnchor));
});

// ============================================================================
// VR windows: menu, keyboard, Hide/Show UI (all painted by htmlInCanvas.js)
// ============================================================================
const VR_MENU_Y = 1.4;          // menu centre height (local-floor; eyes ~1.6 m)
const VR_HUD_DISTANCE = 0.85;   // head-locked Hide/Show UI button
const vrKeyboardEl = document.getElementById('gs-vr-keyboard');
const vrHudEl = document.getElementById('gs-vr-hud');
const vrHudToggle = document.getElementById('gs-vr-hud-toggle');

function kbEscape(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function vrFieldLabel(field) {
	if (!field) return '';
	const aria = field.getAttribute('aria-label');
	if (aria) return aria;
	if (field.placeholder) return field.placeholder;
	if (field.id && field.labels && field.labels[0]) return field.labels[0].textContent.trim();
	return 'text field';
}

// Rebuild the keyboard's buttons (letters/symbols layer, shift state, and
// "Send" vs "Enter" for the field being typed into).
function renderVrKeyboard() {
	if (!vrKeyboardEl) return;
	const rows = keyboardSymbols ? KB_ROWS_SYMBOLS : KB_ROWS_LETTERS;
	const multiline = vrKeyboardTarget instanceof HTMLTextAreaElement && vrKeyboardTarget !== desktopChatInput && vrKeyboardTarget !== dchatThemeChatInput;
	const parts = [
		`<div class="gs-vr-kb-head"><span>Typing in: ${kbEscape(vrFieldLabel(vrKeyboardTarget))}</span>` +
		'<button type="button" class="gs-vr-key gs-vr-key-action gs-vr-kb-done" data-kb-action="done">Done</button></div>'
	];
	for (const row of rows) {
		parts.push('<div class="gs-vr-kb-row">');
		for (const raw of row) {
			const k = normalizeKey(raw);
			let label = k.label;
			if (k.action === 'char' && keyboardShift && /^[a-z]$/.test(k.value)) label = k.value.toUpperCase();
			if (k.action === 'enter') label = multiline ? 'Enter' : 'Send';
			const cls = ['gs-vr-key'];
			if (k.action !== 'char') cls.push('gs-vr-key-action');
			if (k.action === 'enter') cls.push('gs-vr-key-enter');
			if (k.action === 'shift' && keyboardShift) cls.push('active');
			parts.push(`<button type="button" class="${cls.join(' ')}" style="flex-grow:${k.w}" data-kb-action="${k.action}" data-kb-value="${kbEscape(k.value)}">${kbEscape(label)}</button>`);
		}
		parts.push('</div>');
	}
	vrKeyboardEl.innerHTML = parts.join('');
}

// A text field in a VR window was pointed at: type into it with the VR
// keyboard. The field is marked (.gs-vr-typing) instead of DOM-focused.
function openVrKeyboard(field) {
	if (!field) return;
	if (vrKeyboardTarget && vrKeyboardTarget !== field) vrKeyboardTarget.classList.remove('gs-vr-typing');
	vrKeyboardTarget = field;
	field.classList.add('gs-vr-typing');
	try { field.setSelectionRange(field.value.length, field.value.length); } catch { /* type=number etc. */ }
	keyboardShift = false;
	keyboardSymbols = false;
	vrKeyboardOpen = true;
	renderVrKeyboard();
	applyXrPanelVisibility();
	layoutVrWindows();
}

function closeVrKeyboard({ apply = true } = {}) {
	if (vrKeyboardTarget) vrKeyboardTarget.classList.remove('gs-vr-typing');
	vrKeyboardTarget = null;
	vrKeyboardOpen = false;
	if (apply) applyXrPanelVisibility();
}

function onVrKeyboardKey(action, value) {
	if (action === 'done') { closeVrKeyboard(); return; }
	const target = vrKeyboardTarget;
	if (!target || !target.isConnected) { closeVrKeyboard(); return; }
	if (action === 'enter' && (target === desktopChatInput || target === dchatThemeChatInput)) {
		sendActiveChatField();
		return;
	}
	dispatchKeyToDomField(target, { action, value });
}

if (vrKeyboardEl) {
	vrKeyboardEl.addEventListener('click', (e) => {
		const key = e.target.closest('[data-kb-action]');
		if (!key) return;
		onVrKeyboardKey(key.dataset.kbAction, key.dataset.kbValue);
	});
}
if (vrHudToggle) vrHudToggle.addEventListener('click', () => toggleUi());

// After any click in the menu: drop the keyboard if the field it was typing
// into went away (tab switch, dialog closed).
function onVrWindowActivate(win, el, field) {
	if (!vrKeyboardOpen || win !== vrMainWindow || isHtmlTextField(field)) return;
	const t = vrKeyboardTarget;
	if (!t || !t.isConnected || t.getClientRects().length === 0) closeVrKeyboard();
}

// Menu centred at VR_MENU_Y, keyboard right under it, HUD at the top right
// of the view. Every window uses the same CSS px -> metre scale.
function placeVrMenuLight() {
	if (!vrMainWindow) return;
	const m = vrMainWindow.mesh.position;
	vrMenuLight.position.set(m.x, m.y + vrMainWindow.heightM / 2 + VR_MENU_LIGHT_ABOVE, m.z + VR_MENU_LIGHT_FORWARD);
}
function syncVrMenuLight() {
	const inXr = !!(renderer && renderer.xr && renderer.xr.isPresenting);
	if (!inXr || displayOnlyMode) { if (vrMenuLight.parent) vrMenuLight.parent.remove(vrMenuLight); return; }
	if (vrMenuLight.parent !== panelAnchor) panelAnchor.add(vrMenuLight);
	placeVrMenuLight();
	vrMenuLight.intensity = vrMainWindow && vrMainWindow.mesh.visible ? VR_MENU_LIGHT_INTENSITY : 0;
}
window.gsMenuLight = vrMenuLight; // tests / debugging

function layoutVrWindows() {
	if (!vrWindows) return;
	const z = -VR_WINDOW_DISTANCE;
	vrMainWindow.mesh.position.set(0, VR_MENU_Y, z);
	const kbTop = VR_MENU_Y - vrMainWindow.heightM / 2 - VR_KEYBOARD_GAP;
	vrKeyboardWindow.mesh.position.set(0, kbTop - vrKeyboardWindow.heightM / 2, z);
	vrHudWindow.mesh.position.set(0.36 - vrHudWindow.widthM / 2, 0.2, -VR_HUD_DISTANCE);
}

function initVrWindows() {
	vrWindows = createVrWindowManager({
		THREE,
		paint: paintElementToCanvas,
		onTextFieldFocus: (field) => openVrKeyboard(field),
		onActivate: onVrWindowActivate
	});
	// Window chrome that only makes sense with a mouse is not clickable in VR.
	const blockDesktopChrome = (el) => !!el.closest('#desktop-chat-minimize, .dchat-resize');
	vrMainWindow = vrWindows.createWindow({ name: 'menu', source: desktopChat, parent: panelAnchor, blocked: blockDesktopChrome });
	vrKeyboardWindow = vrWindows.createWindow({ name: 'keyboard', source: vrKeyboardEl, parent: panelAnchor });
	vrHudWindow = vrWindows.createWindow({ name: 'hud', source: vrHudEl, parent: hud, distance: VR_HUD_DISTANCE });
	for (const w of vrWindows.windows) {
		w.onResize = layoutVrWindows;
		// Same menu layer / draw order as the rest of the XR UI (always on top).
		registerMenuRoot(w.mesh);
	}
	renderVrKeyboard();
	layoutVrWindows();
	// Test / debug hook (read-only use in test-harness/vr-windows).
	window.__gsVrWindows = vrWindows;
}


// ============================================================================
// In-app dialogs (gsDialog.js) in VR
// ============================================================================
// gsAlert / gsConfirm / gsPrompt show an HTML modal on the page. While an XR
// session is presenting, the same card is a VR window placed in front of the
// user's head (yaw only, re-placed each time a dialog opens) and is modal:
// visibleVrWindowMeshes() hands the controller rays only the dialog and the
// keyboard. A prompt's text field opens the VR keyboard right under the card.
let _vrDialogPlaceNext = false;
const VR_DIALOG_DISTANCE = 1.2;
const VR_DIALOG_DROP = 0.12;      // card centre this far below eye level
const VR_DIALOG_KB_GAP = 0.03;
const vrDialogAnchor = new THREE.Group();
vrDialogAnchor.name = 'gsDialogAnchor';
scene.add(vrDialogAnchor);
const _dlgHead = new THREE.Vector3();
const _dlgDir = new THREE.Vector3();

function placeVrDialog() {
	const cam = renderer.xr.getCamera();
	cam.getWorldPosition(_dlgHead);
	cam.getWorldDirection(_dlgDir);
	_dlgDir.y = 0;
	if (_dlgDir.lengthSq() < 1e-4) _dlgDir.set(0, 0, -1);
	_dlgDir.normalize();
	vrDialogAnchor.position.set(_dlgHead.x + _dlgDir.x * VR_DIALOG_DISTANCE, _dlgHead.y - VR_DIALOG_DROP, _dlgHead.z + _dlgDir.z * VR_DIALOG_DISTANCE);
	vrDialogAnchor.rotation.set(0, Math.atan2(-_dlgDir.x, -_dlgDir.z), 0);
	vrDialogAnchor.updateMatrixWorld(true);
}

function vrDialogTyping() {
	return !!(vrDialogWindow && vrDialogWindow.visible && vrKeyboardOpen && vrKeyboardTarget && vrDialogWindow.source.contains(vrKeyboardTarget));
}

// Keyboard under the dialog while typing into it, back under the menu after.
function layoutVrDialogKeyboard() {
	if (!vrKeyboardWindow) return;
	const kb = vrKeyboardWindow.mesh;
	if (vrDialogTyping()) {
		if (kb.parent !== vrDialogAnchor) vrDialogAnchor.add(kb);
		vrKeyboardWindow.setVisible(true);
		kb.position.set(0, -vrDialogWindow.heightM / 2 - VR_DIALOG_KB_GAP - vrKeyboardWindow.heightM / 2, 0.02);
	} else if (kb.parent === vrDialogAnchor) {
		panelAnchor.add(kb);
		layoutVrWindows();
	}
}

// Per XR frame (from the render loop): place a newly shown dialog, face the
// camera, keep the keyboard with it.
function tickVrDialog(cameraWorldPos) {
	if (!vrDialogWindow || !vrDialogWindow.visible) {
		if (vrKeyboardWindow && vrKeyboardWindow.mesh.parent === vrDialogAnchor) layoutVrDialogKeyboard();
		return;
	}
	if (_vrDialogPlaceNext) { _vrDialogPlaceNext = false; placeVrDialog(); }
	vrDialogWindow.mesh.lookAt(cameraWorldPos);
	layoutVrDialogKeyboard();
}

function initVrDialogWindow() {
	if (!vrWindows) return;
	vrDialogWindow = vrWindows.createWindow({ name: 'dialog', source: dialogCard(), parent: vrDialogAnchor, distance: VR_DIALOG_DISTANCE });
	registerMenuRoot(vrDialogWindow.mesh);
	// Each question has its own height, so this window's canvas changes size.
	// three.js allocates a texture's GPU storage once (texStorage2D) and does not
	// notice a resized canvas, which would leave the previous question showing;
	// dispose so the next upload allocates at the new size.
	const paintDialog = vrDialogWindow.tick;
	vrDialogWindow.tick = (...args) => {
		const { canvas, texture } = vrDialogWindow;
		const w = canvas.width, h = canvas.height;
		const painted = paintDialog(...args);
		if (canvas.width !== w || canvas.height !== h) texture.dispose();
		return painted;
	};
	configureDialogs({
		isImmersive: () => xrSessionActive(),
		onShow: (card, d) => {
			_vrDialogPlaceNext = true;
			if (xrSessionActive()) placeVrDialog();
			vrDialogWindow.setVisible(true);
			if (d && d.input) openVrKeyboard(d.input);
			layoutVrDialogKeyboard();
		},
		onHide: (card) => {
			if (vrKeyboardTarget && card.contains(vrKeyboardTarget)) closeVrKeyboard();
			vrDialogWindow.setVisible(false);
			for (let i = 0; i < 2; i++) vrDialogWindow.setHover(i, null);
			layoutVrDialogKeyboard();
		}
	});
	renderer.xr.addEventListener('sessionstart', refreshDialogMode);
	renderer.xr.addEventListener('sessionend', refreshDialogMode);
}

// The page's own alert / confirm / prompt (AI-written scene code, p5 helpers,
// anything else) open these dialogs too; see installDialogGlobals.
installDialogGlobals(window);

function dispatchKeyToDomField(el, key) {
	const write = (text) => {
		const start = el.selectionStart == null ? el.value.length : el.selectionStart;
		const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
		el.value = el.value.slice(0, start) + text + el.value.slice(end);
		const pos = start + text.length;
		try { el.setSelectionRange(pos, pos); } catch { /* type=number etc. */ }
		el.dispatchEvent(new Event('input', { bubbles: true }));
	};
	switch (key.action) {
		case 'char': {
			let c = key.value;
			if (keyboardShift && /^[a-z]$/.test(c)) c = c.toUpperCase();
			write(c);
			if (keyboardShift) {
				keyboardShift = false;
				renderVrKeyboard();
			}
			break;
		}
		case 'space':
			write(' ');
			break;
		case 'backspace': {
			const start = el.selectionStart == null ? el.value.length : el.selectionStart;
			const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
			if (start === end && start > 0) {
				el.value = el.value.slice(0, start - 1) + el.value.slice(end);
				try { el.setSelectionRange(start - 1, start - 1); } catch { /* ignore */ }
			} else {
				el.value = el.value.slice(0, start) + el.value.slice(end);
				try { el.setSelectionRange(start, start); } catch { /* ignore */ }
			}
			el.dispatchEvent(new Event('input', { bubbles: true }));
			break;
		}
		case 'shift':
			keyboardShift = !keyboardShift;
			renderVrKeyboard();
			break;
		case 'symbols':
			keyboardSymbols = !keyboardSymbols;
			keyboardShift = false;
			renderVrKeyboard();
			break;
		case 'enter':
			// The chat inputs are textareas too, but their Enter is Send.
			if (el instanceof HTMLTextAreaElement && !el.classList.contains('gs-chat-textarea')) write('\n');
			else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			break;
	}
}

// ============================================================================
// Initialize and Animation Loop
// ============================================================================
migrateLayDownState();
// The menu and keyboard windows ride on panelAnchor (identity in Fixed mode).
initVrWindows();
initVrDialogWindow();
renderDomEnv();
renderDomSceneList();
{
	let savedAnchor = null;
	try { savedAnchor = localStorage.getItem(WINDOW_ANCHOR_STORAGE_KEY); } catch { /* storage blocked */ }
	windowAnchorMode = savedAnchor === 'follow' ? 'follow' : 'fixed';
	renderWindowAnchorUi();
}
// Start in windowed (non-XR) mode: the desktop chat window is the UI; the VR
// windows stay hidden until a VR session starts.
setImmersiveUiMode(false);
applyEnvironmentMode();

// Populate the community list (and auto-load /s/:id or /e/:id / ?scene= shares).
// Runs after setImmersiveUiMode so display-only can hide the desktop chrome cleanly.
// Theme restore is opt-in (Remember theme). Default: start from DEFAULT_THEME
// and do not keep a previously saved theme around.
if (rememberTheme) {
	const cachedTheme = loadCachedTheme();
	if (cachedTheme) applyTheme(cachedTheme);
	else currentTheme = { ...DEFAULT_THEME, cssVars: { ...DEFAULT_THEME.cssVars } };
} else {
	currentTheme = { ...DEFAULT_THEME, cssVars: { ...DEFAULT_THEME.cssVars } };
	try { localStorage.removeItem(THEME_CACHE_KEY); } catch { /* ignore */ }
}

loadContextLibrary();

bootSharedScene();

// Snapshot system objects so we can distinguish user-created objects later
snapshotSystemObjects();

// Add welcome message
displayMessages.push({ role: 'assistant', content: WELCOME_MSG });
renderDomChat();

const _rayTempMatrix = new THREE.Matrix4();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _hitRaycaster = new THREE.Raycaster();
const _hitTargets = []; // visible VR window meshes, rebuilt each XR frame

// The VR windows registered themselves in initVrWindows(); reticles in
// createReticle. Anything added under these roots later is pulled onto layer 1
// by applyMenuLayerPriority() each frame.
registerMenuRoot(hud);
applyMenuLayerPriority();
// Previous per-hand button-pressed state, for edge detection (ray toggle) and
// hold detection (push-to-talk). Keyed by handedness → button index → bool.
const _prevButtons = { left: {}, right: {} };
const _cameraWorldPos = new THREE.Vector3();
const _tmpHitNormal = new THREE.Vector3();
const _noHits = [];
const VR_RETICLE_COLOR = 0xfacc15; // same amber as the .gs-ray-hover ring

// The controller (three's target-ray group) for a handedness, or null.
function xrControllerForHand(hand) {
	for (let i = 0; i < 2; i++) {
		const c = renderer.xr.getController(i);
		if (c && c.userData.handedness === hand) return { controller: c, index: i };
	}
	return null;
}

// The VR window (and texture uv) under that hand's ray, or null.
function vrWindowUnderRay(hand) {
	if (!vrWindows) return null;
	const found = xrControllerForHand(hand);
	if (!found) return null;
	const c = found.controller;
	_rayTempMatrix.identity().extractRotation(c.matrixWorld);
	_rayOrigin.setFromMatrixPosition(c.matrixWorld);
	_rayDir.set(0, 0, -1).applyMatrix4(_rayTempMatrix);
	_hitRaycaster.set(_rayOrigin, _rayDir);
	const hit = _hitRaycaster.intersectObjects(visibleVrWindowMeshes(_selectTargets), false).find((h) => h.uv);
	const win = hit && vrWindows.byMesh(hit.object);
	return win ? { win, uv: hit.uv, index: found.index } : null;
}

// Thumbstick scroll: either stick scrolls whatever scrolls vertically under
// that hand's ray (the Code tab, chat log, lists). While the ray is on such a
// box that hand's stick belongs to the window, so it does not also move or
// turn you (see _stickOwnedByWindow / updateLocomotion). With locomotion off
// it is the only thing the sticks do. Returns true when the stick was used.
const _stickOwnedByWindow = { left: false, right: false };
function stickScrollVrWindow(hand, dy) {
	const under = vrWindowUnderRay(hand);
	if (!under || !under.win.verticalScrollerAt(under.uv)) return false;
	if (dy) under.win.scrollAt(under.uv, dy);
	return true;
}

// ---------------------------------------------------------------------------
// VR: grab the origin-rotation gizmo (Environment tab) with a controller.
// Point the ray at the gizmo and hold the grip (squeeze) button: the scene's
// origin rotation follows the controller's own rotation from that moment
// (delta = now * inverse(start), applied on top of the rotation at grab
// time), live, like dragging the 2D gizmo. Release the grip to let go.
// Either controller. Hand tracking has no grip button, so it never grabs.
// While grabbing, the sticks do not move you and the right grip does not
// cycle locomotion.
// ---------------------------------------------------------------------------
let vrGizmoGrab = null; // { hand, startQ: Quaternion, base: Quaternion }
const _gizmoGrabQ = new THREE.Quaternion();
const _gizmoGrabDelta = new THREE.Quaternion();
function originGizmoUnderRay(hand) {
	const under = vrWindowUnderRay(hand);
	if (!under || under.win !== vrMainWindow) return false;
	const el = under.win.elementAtUV(under.uv);
	return !!(el && el.closest && el.closest('#dchat-origin-gizmo'));
}
function beginVrGizmoGrab(hand) {
	if (vrGizmoGrab || !originRotation || !originGizmoUnderRay(hand)) return false;
	const found = xrControllerForHand(hand);
	if (!found) return false;
	found.controller.updateMatrixWorld(true);
	vrGizmoGrab = { hand, startQ: found.controller.getWorldQuaternion(new THREE.Quaternion()), base: originRotation.beginGrab() };
	return true;
}
function updateVrGizmoGrab() {
	if (!vrGizmoGrab) return;
	const found = xrControllerForHand(vrGizmoGrab.hand);
	if (!found) { endVrGizmoGrab(); return; }
	found.controller.getWorldQuaternion(_gizmoGrabQ);
	_gizmoGrabDelta.copy(vrGizmoGrab.startQ).invert().premultiply(_gizmoGrabQ); // now * inverse(start)
	originRotation.grabRotate(vrGizmoGrab.base, _gizmoGrabDelta);
}
function endVrGizmoGrab() {
	if (!vrGizmoGrab) return;
	vrGizmoGrab = null;
	originRotation.endGrab();
}
// Read-only test / debug hook (test-harness/vr-input).
window.gsVrInput = {
	get locomotionMode() { return locomotionMode; },
	get gizmoGrab() { return vrGizmoGrab ? { hand: vrGizmoGrab.hand } : null; },
	get stickOwnedByWindow() { return { ..._stickOwnedByWindow }; },
	playerPosition() { return player ? player.position.clone() : null; },
	playerQuaternion() { return player ? player.quaternion.clone() : null; }
};

renderer.setAnimationLoop((time) => {
	// Frame delta (seconds), clamped so a paused/backgrounded tab doesn't jump.
	const dt = _locoPrevTime ? Math.min(0.1, (time - _locoPrevTime) / 1000) : 0;
	_locoPrevTime = time;

	// Voice-activity detection for always-on mic. Driven here (not via
	// window.requestAnimationFrame, which is paused during immersive sessions) so
	// transcription segmentation works in MR as well as the windowed view.
	pumpVad();
	// Camera frames -> chat preview canvas / gsPassthroughTexture (here, not rAF
	// or requestVideoFrameCallback, which stop inside an immersive session).
	gsCamPipeline.tick();


	// Billboard effect: panels face the camera while staying upright
	if (renderer.xr.isPresenting) {
		const xrCamera = renderer.xr.getCamera();
		const cameraWorldPos = _cameraWorldPos;
		xrCamera.getWorldPosition(cameraWorldPos);
		updatePanelAnchor(dt, xrCamera);
		if (vrMenuLight.parent) placeVrMenuLight(); // menu height follows its content

		// World windows face the camera while staying upright.
		vrMainWindow.mesh.lookAt(cameraWorldPos);
		vrKeyboardWindow.mesh.lookAt(cameraWorldPos);
		tickVrDialog(cameraWorldPos);

		// Ray targets: the VR windows that are showing.
		visibleVrWindowMeshes(_hitTargets);

		for (let i = 0; i < 2; i++) {
			const controller = renderer.xr.getController(i);
			const reticle = reticles[i];
			if (!controller || !reticle) continue;

			_rayTempMatrix.identity().extractRotation(controller.matrixWorld);
			_rayOrigin.setFromMatrixPosition(controller.matrixWorld);
			_rayDir.set(0, 0, -1).applyMatrix4(_rayTempMatrix);

			_hitRaycaster.set(_rayOrigin, _rayDir);
			const intersects = _hitTargets.length ? _hitRaycaster.intersectObjects(_hitTargets, false) : _noHits;

			// Canvas surfaces (p5 / blank canvas) — hover, cursor dot, events.
			const surfHit = updateSurfacePointer(i, _rayOrigin, _rayDir, intersects, reticle);
			const hit = !surfHit && intersects.length > 0 ? intersects[0] : null;
			const hitWin = hit ? vrWindows.byMesh(hit.object) : null;
			if (hit) {
				reticle.position.copy(hit.point);
				// Face along hit normal (toward the camera side of the window)
				_tmpHitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
				if (_tmpHitNormal.dot(_rayDir) > 0) _tmpHitNormal.negate();
				reticle.lookAt(hit.point.x + _tmpHitNormal.x, hit.point.y + _tmpHitNormal.y, hit.point.z + _tmpHitNormal.z);
				reticle.material.color.setHex(VR_RETICLE_COLOR);
				reticle.visible = true;
			} else if (!surfHit) {
				reticle.visible = false;
			}
			// Same hover ring on every window (.gs-ray-hover, see index.html).
			for (const w of vrWindows.windows) {
				if (w.drag[i] && hit && hitWin === w) w.moveDrag(i, hit.uv);
				w.setHover(i, hitWin === w && hit.uv ? hit.uv : null, time);
			}
		}
		// Dirty-driven repaints (<= ~15/s per window, idle refresh every 2 s).
		vrWindows.tickAll(time);
		// Poll thumbsticks (scrolling) and buttons (ray toggle + push-to-talk)
		const session = renderer.xr.getSession();
		if (session) {
			for (const source of session.inputSources) {
				const gp = source.gamepad;
				const hand = source.handedness;

				if (gp && (hand === 'left' || hand === 'right')) {
					const prev = _prevButtons[hand];
					// B / Y button (index 5): toggle pointer ray lines on press (edge).
					const b5 = !!(gp.buttons[5] && gp.buttons[5].pressed);
					if (b5 && !prev[5]) toggleRayVisibility();
					prev[5] = b5;
					// A / X button (index 4): push-to-talk — listen while held.
					const b4 = !!(gp.buttons[4] && gp.buttons[4].pressed);
					if (b4 && !prev[4]) startPTT(hand);
					if (!b4 && prev[4]) stopPTT(hand);
					prev[4] = b4;
					// Thumbstick press (index 3): collapse / restore all UI. A reliable
					// fallback for the head-locked Hide/Show-UI button.
					const b3 = !!(gp.buttons[3] && gp.buttons[3].pressed);
					if (b3 && !prev[3]) toggleUi();
					prev[3] = b3;
					// Grip / squeeze (index 1), either hand: with the ray on the
					// origin gizmo, grab it (rotate the scene with the controller)
					// until released. Otherwise the right grip cycles locomotion
					// mode (off → planar → free-roam).
					const b1 = !!(gp.buttons[1] && gp.buttons[1].pressed);
					if (b1 && !prev[1]) {
						if (!beginVrGizmoGrab(hand) && hand === 'right') cycleLocomotionMode();
					}
					if (!b1 && prev[1] && vrGizmoGrab && vrGizmoGrab.hand === hand) endVrGizmoGrab();
					prev[1] = b1;
				}

				// Thumbsticks: over something that scrolls, that hand's stick
				// scrolls it (and does not move you); elsewhere they drive
				// movement/turning (updateLocomotion below), or nothing with
				// locomotion off.
				_stickOwnedByWindow[hand] = false;
				const axes = gp ? gp.axes : null;
				if (!axes || (hand !== 'left' && hand !== 'right')) continue;
				const thumbX = axes.length >= 4 ? axes[2] : (axes[0] || 0);
				const thumbY = axes.length >= 4 ? axes[3] : (axes.length >= 2 ? axes[1] : 0);
				if (Math.abs(thumbY) > THUMBSTICK_DEADZONE || Math.abs(thumbX) > THUMBSTICK_DEADZONE) {
					const dy = Math.abs(thumbY) > THUMBSTICK_DEADZONE ? thumbY * STICK_SCROLL_PX_PER_S * dt : 0;
					_stickOwnedByWindow[hand] = stickScrollVrWindow(hand, dy);
				}
			}
			if (vrGizmoGrab && !session.inputSources.length) endVrGizmoGrab();
			updateVrGizmoGrab();

			// Locomotion: left stick moves, right stick turns.
			updateLocomotion(dt, session);
		}
	} else if (mobileXRMode) {
		// Hide reticles - no controllers in Cardboard/AR-camera mode
		for (const r of reticles) if (r) r.visible = false;
		// Gyro matches the phone to the camera feed (look by pointing the device).
		// Touch does NOT rotate the camera — in Walk-in-AR it drags the scene
		// placement instead. Hold-to-walk still nudges position if needed.
		updateCameraFromDeviceOrientation();
		if (mobileMoveHeld) applyLocomotionInput(dt, camera, 0, -1, 0, 0);
	} else {
		// Hide reticles outside XR
		for (const r of reticles) if (r) r.visible = false;
		// Desktop / phone camera: the active stock three.js control.
		cameraControls.update(dt);
	}

	// Game controllers (Gamepad API): poll once per frame before scene code
	// runs, so gsGamepad.justPressed() is fresh inside _vrAnimations.
	updateGamepads(dt);

	// Run user-injected animations from vr-exec code
	for (const animFn of window._vrAnimations) {
		try {
			animFn(time);
		} catch (e) {
			// Silently skip broken animation functions
		}
	}

	// Rotated origin: pull anything scene code added to `scene` this frame into
	// the origin root, and repaint the Environment gizmo if the view turned.
	if (originRotationActive()) adoptSceneContentIntoOrigin();
	originRotation.tick(renderer.xr.isPresenting);

	// Re-apply after user animations so children parented to the menu this
	// frame (and any material swapped onto a panel) still render on layer 1.
	applyMenuLayerPriority();

	// Domes and fog follow the scene bounds (sceneFit.js; ~2.5 times a second),
	// then match the VR render distance and reach the whole scene (see
	// syncRenderDistance) before any render.
	sceneFit.tick(time, sceneFitViewer());
	sceneFit.fogFarFor(sceneFitViewer());
	syncRenderDistance();

	// An HDRI with "Use as background" on stays the background (see keepHdriBackground).
	keepHdriBackground();

	if (mobileXRMode === 'cardboard') {
		// Manual side-by-side stereo render (no OpenXR session to do this for us).
		stereoCam.update(camera);
		const w = _rendererSize.w, h = _rendererSize.h;
		renderer.setScissorTest(true);
		renderer.setScissor(0, 0, w / 2, h);
		renderer.setViewport(0, 0, w / 2, h);
		renderer.render(scene, stereoCam.cameraL);
		renderer.setScissor(w / 2, 0, w / 2, h);
		renderer.setViewport(w / 2, 0, w / 2, h);
		renderer.render(scene, stereoCam.cameraR);
		renderer.setScissorTest(false);
		renderer.setViewport(0, 0, w, h);
	} else {
		renderer.render(scene, camera);
	}
});
