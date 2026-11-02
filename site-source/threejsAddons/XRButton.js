/**
 * A utility class for creating a button that starts an immersive WebXR
 * session: immersive-vr, or immersive-ar (passthrough) when GS's AR / VR
 * toggle asks for it (sessionInit.getMode).
 *
 * Usage:
 * document.body.appendChild( XRButton.createButton( renderer ) );
 *
 * GS extras on sessionInit (not passed to requestSession):
 *   getMode():  'immersive-vr' | 'immersive-ar', read on every click / label
 *               refresh (default 'immersive-vr').
 *   onSupport({ vr, ar }): called once both isSessionSupported() answers are in.
 *   onSessionMode(mode): called with the mode right before renderer.xr.setSession.
 * button.gsRefreshMode() re-reads getMode() and updates the label.
 */
class XRButton {

	/**
	 * Constructs a new XR button.
	 *
	 * @param {WebGLRenderer|WebGPURenderer} renderer - The renderer.
	 * @param {XRSessionInit} [sessionInit] - Optional session configuration
	 *   applied to the immersive-vr session.
	 * @return {HTMLElement} The button or an error message if
	 *   'immersive-vr' is not supported.
	 */
	static createButton( renderer, sessionInit = {} ) {

		const button = document.createElement( 'button' );
		const { getMode, onSupport, onSessionMode, ...requestInit } = sessionInit;
		sessionInit = requestInit;
		const support = { vr: false, ar: false };
		const wantedMode = () => {

			const m = typeof getMode === 'function' ? getMode() : 'immersive-vr';
			if ( m === 'immersive-ar' && support.ar ) return 'immersive-ar';
			if ( support.vr ) return 'immersive-vr';
			return support.ar ? 'immersive-ar' : 'immersive-vr';

		};
		const enterLabel = () => ( wantedMode() === 'immersive-ar' ? 'ENTER AR' : 'ENTER VR' );
		button.gsRefreshMode = function () {};

		function showEnterXR() {

			let currentSession = null;
			let currentMode = null;

			async function onSessionStarted( session ) {

				session.addEventListener( 'end', onSessionEnded );

				// Use 'local-floor' so the world origin sits at the real floor
				// (y=0 = ground). With plain 'local', the origin is wherever
				// the headset is at session start, which puts y=0 at eye level.
				// An AR session may not grant local-floor (it is optional
				// there); fall back to 'local' then.
				const features = session.enabledFeatures;
				const floor = ! features || features.includes( 'local-floor' );
				if ( renderer.xr && renderer.xr.setReferenceSpaceType ) {
					renderer.xr.setReferenceSpaceType( floor ? 'local-floor' : 'local' );
				}

				if ( typeof onSessionMode === 'function' ) onSessionMode( currentMode );
				await renderer.xr.setSession( session );
				button.textContent = currentMode === 'immersive-ar' ? 'EXIT AR' : 'EXIT VR';

				currentSession = session;

			}

			function onSessionEnded() {

				currentSession.removeEventListener( 'end', onSessionEnded );

				button.textContent = enterLabel();

				currentSession = null;
				currentMode = null;

			}

			//

			button.style.display = '';

			button.style.cursor = 'pointer';
			button.style.left = '50%';
			button.style.width = '';

			button.textContent = enterLabel();
			button.gsRefreshMode = function () {

				if ( currentSession === null ) button.textContent = enterLabel();

			};

			// Request useful optional features when available.
			// 'local-floor' must be in requiredFeatures or optionalFeatures
			// for setReferenceSpaceType('local-floor') to succeed; otherwise
			// the UA falls back to 'local' silently.
			const vrOptions = {
				...sessionInit,
				requiredFeatures: [
					'local-floor',
					...( sessionInit.requiredFeatures || [] )
				],
				optionalFeatures: [
					'layers',
					'bounded-floor',
					...( sessionInit.optionalFeatures || [] )
				]
			};
			// immersive-ar (Quest 3 passthrough, ARCore phones): local-floor is
			// optional, so devices that only do 'local' still start.
			const arOptions = {
				...sessionInit,
				requiredFeatures: [ ...( sessionInit.requiredFeatures || [] ) ],
				optionalFeatures: [
					'local-floor',
					'layers',
					'bounded-floor',
					...( sessionInit.optionalFeatures || [] )
				]
			};

			button.onmouseenter = function () {

				button.style.opacity = '1.0';

			};

			button.onmouseleave = function () {

				button.style.opacity = '0.5';

			};

			button.onclick = function () {

				if ( currentSession === null ) {

					const mode = wantedMode();
					currentMode = mode;
					navigator.xr.requestSession( mode, mode === 'immersive-ar' ? arOptions : vrOptions ).then( onSessionStarted ).catch( function ( err ) {

						currentMode = null;
						console.warn( 'XR session request failed (' + mode + '):', err );

					} );

				} else {

					currentSession.end();

				}

			};

		}

		function disableButton() {

			button.style.display = '';

			button.style.cursor = 'auto';
			button.style.left = '50%';
			button.style.width = '';

			button.onmouseenter = null;
			button.onmouseleave = null;

			button.onclick = null;

		}

		function showWebXRNotFound() {

			disableButton();

			button.textContent = 'VR NOT SUPPORTED';

		}

		function showXRNotAllowed( exception ) {

			disableButton();

			console.warn( 'Exception when trying to call xr.isSessionSupported', exception );

			button.textContent = 'VR NOT ALLOWED';

		}

		function stylizeElement( element ) {

			// Visuals mostly live in index.html (#XRButton) for responsive /
			// high-contrast mobile styles; keep only layout-critical inline bits.
			element.classList.add( 'xr-entry-btn' );
			element.style.position = 'fixed';
			element.style.bottom = '';
			element.style.padding = '';
			element.style.border = '';
			element.style.borderRadius = '';
			element.style.background = '#f4f4f8';
			element.style.color = '#12121a';
			element.style.font = '600 14px/1.2 -apple-system, BlinkMacSystemFont, sans-serif';
			element.style.textAlign = 'center';
			element.style.opacity = '1';
			element.style.outline = 'none';
			element.style.zIndex = '999';
			element.style.boxSizing = 'border-box';
			element.style.cursor = 'pointer';
			element.style.webkitTapHighlightColor = 'transparent';

		}

		if ( 'xr' in navigator ) {

			button.id = 'XRButton';
			button.style.display = 'none';

			stylizeElement( button );

			// Both modes are queried; the AR / VR toggle picks one (getMode).
			const ask = ( m ) => navigator.xr.isSessionSupported( m ).catch( function ( e ) {

				console.warn( 'isSessionSupported(' + m + ') failed', e );
				return false;

			} );
			Promise.all( [ ask( 'immersive-vr' ), ask( 'immersive-ar' ) ] ).then( function ( [ vr, ar ] ) {

				support.vr = !! vr;
				support.ar = !! ar;
				if ( typeof onSupport === 'function' ) onSupport( { ...support } );
				vr || ar ? showEnterXR() : showWebXRNotFound();

			} ).catch( showXRNotAllowed );

			return button;

		} else {

			const message = document.createElement( 'a' );

			if ( window.isSecureContext === false ) {

				message.href = document.location.href.replace( /^http:/, 'https:' );
				message.innerHTML = 'WEBXR NEEDS HTTPS';

			} else {

				message.href = 'https://immersiveweb.dev/';
				message.innerHTML = 'WEBXR NOT AVAILABLE';

			}

			message.style.left = '50%';
			message.style.width = '';
			message.style.textDecoration = 'none';

			stylizeElement( message );

			return message;

		}

	}

}

export { XRButton };
