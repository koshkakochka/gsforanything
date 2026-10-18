// On-screen twin joysticks for Free-roam (desktop and phone).
//
// Two small, semi-transparent sticks: a thin ring with a small knob in the
// bottom-left (move) and bottom-right (look) corners, above the bottom dock.
// They only take pointer events inside their own ring, so taps anywhere else
// still reach the scene and the panels. Each stick follows one pointer
// (touch, mouse or pen), so both can be used at once with two fingers.
// main.js reads the axes every frame and applies the same deadzone and
// speeds as the gamepad's Free-roam.
//
// Axes use gamepad conventions, -1..1: x = right, y = down
// (so pushing the left stick up gives y < 0 = forward).

const STYLE = `
#gs-twin-sticks { position: fixed; inset: 0; pointer-events: none; z-index: 990; }
#gs-twin-sticks[hidden] { display: none; }
.gs-stick {
	position: absolute; width: var(--gs-stick-size, 96px); height: var(--gs-stick-size, 96px);
	border-radius: 50%; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
	border: 1.5px solid rgba(255, 255, 255, 0.55); background: rgba(255, 255, 255, 0.04);
	box-sizing: border-box; opacity: 0.45; transition: opacity 0.6s ease; cursor: grab;
	-webkit-tap-highlight-color: transparent;
}
.gs-stick.idle { opacity: 0.2; }
.gs-stick.active { opacity: 0.7; transition: opacity 0.1s ease; cursor: grabbing; }
.gs-stick-knob {
	position: absolute; left: 50%; top: 50%; width: 34%; height: 34%; margin: -17% 0 0 -17%;
	border-radius: 50%; background: rgba(255, 255, 255, 0.55); pointer-events: none;
	box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15);
}
.gs-stick-label {
	position: absolute; left: 0; right: 0; top: 100%; margin-top: 3px; text-align: center;
	font: 600 10px/1 system-ui, sans-serif; letter-spacing: 0.04em; color: rgba(255, 255, 255, 0.55);
	pointer-events: none; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
`;

const IDLE_FADE_MS = 2500;

/**
 * @param {object} [opts]
 * @param {() => {bottom:number}} [opts.layout] returns the bottom offset (px) that keeps the sticks clear of the dock
 */
export function createTwinSticks({ layout } = {}) {
	if (!document.getElementById('gs-twin-sticks-style')) {
		const st = document.createElement('style');
		st.id = 'gs-twin-sticks-style';
		st.textContent = STYLE;
		document.head.appendChild(st);
	}
	const root = document.createElement('div');
	root.id = 'gs-twin-sticks';
	root.hidden = true;
	document.body.appendChild(root);

	const sticks = {};
	let idleTimer = 0;

	function makeStick(side, label) {
		const el = document.createElement('div');
		el.className = 'gs-stick idle';
		el.id = `gs-stick-${side}`;
		el.dataset.stick = side;
		el.setAttribute('aria-label', label);
		el.setAttribute('role', 'application');
		const knob = document.createElement('div');
		knob.className = 'gs-stick-knob';
		const lab = document.createElement('div');
		lab.className = 'gs-stick-label';
		lab.textContent = side === 'left' ? 'MOVE' : 'LOOK';
		el.append(knob, lab);
		root.appendChild(el);
		const s = { el, knob, pointerId: null, cx: 0, cy: 0, r: 1, x: 0, y: 0 };

		const setKnob = () => {
			knob.style.transform = `translate(${s.x * s.r}px, ${s.y * s.r}px)`;
		};
		const update = (e) => {
			let dx = (e.clientX - s.cx) / s.r;
			let dy = (e.clientY - s.cy) / s.r;
			const m = Math.hypot(dx, dy);
			if (m > 1) { dx /= m; dy /= m; }
			s.x = dx; s.y = dy;
			setKnob();
		};
		const release = (e) => {
			if (s.pointerId === null || (e && e.pointerId !== s.pointerId)) return;
			try { el.releasePointerCapture(s.pointerId); } catch { /* ignore */ }
			s.pointerId = null; s.x = 0; s.y = 0;
			setKnob();
			el.classList.remove('active');
			scheduleIdle();
		};
		el.addEventListener('pointerdown', (e) => {
			if (s.pointerId !== null) return;
			e.preventDefault();
			e.stopPropagation();
			s.pointerId = e.pointerId;
			try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
			const b = el.getBoundingClientRect();
			s.cx = b.left + b.width / 2; s.cy = b.top + b.height / 2;
			s.r = Math.max(1, b.width / 2 - b.width * 0.17); // knob stays inside the ring
			markActive();
			el.classList.add('active');
			update(e);
		});
		el.addEventListener('pointermove', (e) => {
			if (e.pointerId !== s.pointerId) return;
			e.preventDefault();
			update(e);
		});
		el.addEventListener('pointerup', release);
		el.addEventListener('pointercancel', release);
		el.addEventListener('lostpointercapture', release);
		el.addEventListener('contextmenu', (e) => e.preventDefault());
		s.release = release;
		sticks[side] = s;
	}

	function markActive() {
		clearTimeout(idleTimer);
		for (const s of Object.values(sticks)) s.el.classList.remove('idle');
	}
	function scheduleIdle() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (Object.values(sticks).some((s) => s.pointerId !== null)) return;
			for (const s of Object.values(sticks)) s.el.classList.add('idle');
		}, IDLE_FADE_MS);
	}

	makeStick('left', 'Move joystick: up and down go forward and back, sideways strafes');
	makeStick('right', 'Look joystick: drag to look around');

	function place() {
		const small = Math.min(window.innerWidth, window.innerHeight) < 520;
		const size = small ? 88 : 96;
		const margin = small ? 14 : 24;
		const bottom = Math.max(margin, (layout?.().bottom ?? 0)) + 14; // room for the label
		root.style.setProperty('--gs-stick-size', `${size}px`);
		for (const [side, s] of Object.entries(sticks)) {
			s.el.style.bottom = `${bottom}px`;
			s.el.style.left = side === 'left' ? `${margin}px` : '';
			s.el.style.right = side === 'right' ? `${margin}px` : '';
		}
	}
	window.addEventListener('resize', place);

	return {
		root,
		/** Show or hide both sticks. Hiding releases any held stick. */
		setVisible(v) {
			v = !!v;
			if (v && root.hidden) { place(); markActive(); scheduleIdle(); }
			if (!v) for (const s of Object.values(sticks)) s.release();
			root.hidden = !v;
		},
		get visible() { return !root.hidden; },
		/** Raw axes (-1..1, gamepad conventions) before any deadzone. */
		axes() {
			return { lx: sticks.left.x, ly: sticks.left.y, rx: sticks.right.x, ry: sticks.right.y };
		},
		get active() { return sticks.left.pointerId !== null || sticks.right.pointerId !== null; },
		place
	};
}
