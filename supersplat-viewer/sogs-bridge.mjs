/**
 * Spaceport SOGS bridge: postMessage API for parent page + optional RGB world axes (mesh, not drawLine overlay).
 * Uses PlayCanvas classes from the bundled viewer (`window.__sogsPc`), not a separate esm.sh build.
 */
import { main } from "./index.js";

const { Color, CylinderGeometry, Entity, Mesh, MeshInstance, StandardMaterial, Vec3 } = window.__sogsPc;

/** Parent-driven camera (position + look-at). When `sogs:cameraMode` is `scripted`, orbit input is skipped. */
const tmpFrom = new Vec3();
const tmpTo = new Vec3();
/** Orbit focus point for `sogs:cameraPose` (parent overlays / Three.js projection). */
const tmpFocus = new Vec3();

/** Half-length of each axis arm from the origin (total span 2× this along each axis). */
const AXIS_LEN = 10;
/** Cylinder radius (÷10 vs prior 0.05 for skinnier rods). */
const AXIS_RADIUS = 0.005;
const MAIN_BOOT_TIMEOUT_MS = 15e3;
const BRIDGE_WAIT_TIMEOUT_MS = 12e3;
/**
 * PlayCanvas default layer ids (must match bundled engine). Gsplat draws in World; we draw axes
 * on Immediate so they composite after the splat and stay visible.
 */
const LAYER_ID_IMMEDIATE = 3;

function getBootOptions() {
  if (typeof window === "undefined") {
    return { quality: "hq", lowQuality: false };
  }
  const fromWindow = window.__sogsBootOptions;
  if (fromWindow && typeof fromWindow === "object") {
    return {
      quality: fromWindow.quality === "lq" ? "lq" : "hq",
      lowQuality: fromWindow.lowQuality === true || fromWindow.quality === "lq"
    };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const lowQuality = params.get("quality") === "lq";
    return {
      quality: lowQuality ? "lq" : "hq",
      lowQuality
    };
  } catch {
    return { quality: "hq", lowQuality: false };
  }
}

function postBootEvent(type, detail = {}) {
  try {
    window.parent.postMessage(
      {
        type,
        ...detail
      },
      "*"
    );
  } catch {
    /* ignore */
  }
}

function withTimeout(promise, timeoutMs, stage) {
  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => {
      reject(new Error(`timeout:${stage}`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(id);
        resolve(value);
      },
      (error) => {
        clearTimeout(id);
        reject(error);
      }
    );
  });
}

function waitForValue(getValue, stage, timeoutMs = BRIDGE_WAIT_TIMEOUT_MS, intervalMs = 30) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const finishReject = (error) => {
      clearInterval(id);
      reject(error);
    };
    const tick = () => {
      try {
        const value = getValue();
        if (value) {
          clearInterval(id);
          resolve(value);
          return;
        }
        if (Date.now() >= deadline) {
          finishReject(new Error(`timeout:${stage}`));
        }
      } catch (error) {
        finishReject(error);
      }
    };
    const id = window.setInterval(tick, intervalMs);
    tick();
  });
}

window.firstFrame = function sogsFirstFrameHook() {
  window.parent.postMessage({ type: "supersplat:firstFrame" }, "*");
  queueMicrotask(() => postSogsState());
};

function postSogsState() {
  try {
    const ctx = window.__sogsCtx;
    if (!ctx?.app || !ctx.camera) {
      return;
    }
    const g = ctx.app.root.findByName("gsplat");
    if (!g) {
      return;
    }
    const p = g.getLocalPosition();
    const e = g.getLocalEulerAngles();
    const sc = g.getLocalScale();
    window.parent.postMessage(
      {
        type: "sogs:state",
        position: [p.x, p.y, p.z],
        rotation: [e.x, e.y, e.z],
        scale: sc.x,
        fov: ctx.camera.camera.fov,
      },
      "*",
    );
  } catch {
    /* ignore */
  }
}

/**
 * Wraps CameraManager.update: free orbit vs scripted pose from `window.__sogsCameraPose`.
 * Orbit consumes InputFrame via `frame.read()` each update; while scripted we skip `origUpdate`,
 * so flush the same `frame` reference each scripted frame. First free frame skips one `origUpdate`
 * so orbit integration cannot nudge the camera away from the last `look()` pose.
 */
function flushSogsAccumulatedInputFrame(frame) {
  try {
    const inputFrame = frame ?? window.__sogsCtx?.viewer?.inputController?.frame;
    if (!inputFrame || typeof inputFrame.read !== "function") return null;
    const fr = inputFrame.read();
    if (!fr) return null;
    const m = fr.move || [0, 0, 0];
    const r = fr.rotate || [0, 0, 0];
    return {
      moveLen: Math.hypot(m[0], m[1], m[2] || 0),
      rotateLen: Math.hypot(r[0], r[1], r[2] || 0),
    };
  } catch {
    return null;
  }
}

function postCameraPoseFromViewer(cameraManager) {
  try {
    if (window.__sogsScriptedCamera) {
      return;
    }
    const cam = cameraManager.camera;
    cam.calcFocusPoint(tmpFocus);
    window.parent.postMessage(
      {
        type: "sogs:cameraPose",
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [tmpFocus.x, tmpFocus.y, tmpFocus.z],
        fov: cam.fov,
      },
      "*",
    );
  } catch {
    /* ignore */
  }
}

/**
 * Keeps the camera eye (logical `Camera.position`) above a world Y floor and/or inside a sphere around origin.
 * Iterates so Y and radius limits can both apply without fighting.
 *
 * After moving only `position`, the orbit camera's `angles` + `distance` would still describe the *old* focus.
 * `calcFocusPoint` would then report a bogus target (often very far). We snapshot the true focus before clamping
 * and run `look(clampedEye, savedFocus)` so the pivot stays fixed while the eye is constrained.
 */
function clampSogsCameraPosition(cameraManager) {
  const yMin = window.__sogsCameraYMin;
  const maxR = window.__sogsCameraMaxRadius;
  const hasY = typeof yMin === "number" && Number.isFinite(yMin);
  const hasR = typeof maxR === "number" && Number.isFinite(maxR) && maxR > 0;
  if (!hasY && !hasR) return false;
  const cam = cameraManager.camera;
  cam.calcFocusPoint(tmpFocus);
  const pos = cam.position;
  let changed = false;
  for (let i = 0; i < 6; i++) {
    if (hasY) {
      const ny = Math.max(pos.y, yMin);
      if (ny !== pos.y) changed = true;
      pos.y = ny;
    }
    if (hasR) {
      const len = pos.length();
      if (len > maxR && len > 1e-20) {
        pos.mulScalar(maxR / len);
        changed = true;
      }
    }
  }
  if (changed) {
    tmpFrom.copy(pos);
    cam.look(tmpFrom, tmpFocus);
  }
  return changed;
}

function setupCameraManagerBridge(cameraManager) {
  const origUpdate = cameraManager.update.bind(cameraManager);
  let prevScripted = false;

  cameraManager.update = (dt, frame) => {
    if (window.__sogsScriptedCamera) {
      const pose = window.__sogsCameraPose;
      if (pose?.position?.length === 3 && pose?.target?.length === 3) {
        tmpFrom.set(pose.position[0], pose.position[1], pose.position[2]);
        tmpTo.set(pose.target[0], pose.target[1], pose.target[2]);
        cameraManager.camera.look(tmpFrom, tmpTo);
        if (typeof pose.fov === "number" && Number.isFinite(pose.fov)) {
          cameraManager.camera.fov = pose.fov;
          window.__sogsUserFov = pose.fov;
        }
      }
      clampSogsCameraPosition(cameraManager);
      flushSogsAccumulatedInputFrame(frame);
      prevScripted = true;
      return;
    }
    const leftScripted = prevScripted;
    prevScripted = false;
    let skipFirstOrbitAfterScripted = false;
    if (leftScripted) {
      flushSogsAccumulatedInputFrame(frame);
      if (typeof cameraManager.syncOrbitFromCurrentCamera === "function") {
        cameraManager.syncOrbitFromCurrentCamera();
      }
      skipFirstOrbitAfterScripted = true;
    }
    if (!skipFirstOrbitAfterScripted) {
      origUpdate(dt, frame);
    }
    if (typeof window.__sogsUserFov === "number" && Number.isFinite(window.__sogsUserFov)) {
      cameraManager.camera.fov = window.__sogsUserFov;
    }
    if (clampSogsCameraPosition(cameraManager) && typeof cameraManager.syncOrbitFromCurrentCamera === "function") {
      cameraManager.syncOrbitFromCurrentCamera();
    }
    postCameraPoseFromViewer(cameraManager);
  };
}

function axisMaterial(rgb) {
  const m = new StandardMaterial();
  m.diffuse = new Color(0, 0, 0);
  m.emissive = new Color(rgb[0], rgb[1], rgb[2]);
  m.emissiveIntensity = 1;
  m.useLighting = false;
  return m;
}

/** After `render` exists: draw on Immediate layer (after World), so gsplat does not paint over axes. */
function setAxisGuideRenderLayer(ent) {
  try {
    if (ent.render) {
      ent.render.layers = [LAYER_ID_IMMEDIATE];
    }
  } catch {
    /* ignore */
  }
}

/**
 * Thin cylinders along local +X / +Y / +Z at the splat origin, parented to gsplat.
 * Uses Immediate render layer so gsplat does not occlude them.
 */
function buildAxisCylinderMesh(app, radius = AXIS_RADIUS) {
  const device = app.graphicsDevice;
  const geom = new CylinderGeometry({
    height: AXIS_LEN,
    radius,
    heightSegments: 1,
    capSegments: 12,
  });
  return Mesh.fromGeometry(device, geom);
}

const AXIS_CONFIGS = [
  { name: "sogsAxisX", ex: 0, ey: 0, ez: -90, px: AXIS_LEN / 2, py: 0, pz: 0, rgb: [0.95, 0.22, 0.18] },
  { name: "sogsAxisY", ex: 0, ey: 0, ez: 0, px: 0, py: AXIS_LEN / 2, pz: 0, rgb: [0.28, 0.92, 0.32] },
  { name: "sogsAxisZ", ex: 90, ey: 0, ez: 0, px: 0, py: 0, pz: AXIS_LEN / 2, rgb: [0.32, 0.52, 0.98] },
];

function setupSogsAxesGuides(app, gsplatEntity) {
  if (window.__sogsAxesRoot) {
    try {
      window.__sogsAxesRoot.destroy();
    } catch {
      /* ignore */
    }
    window.__sogsAxesRoot = null;
  }

  const mesh = buildAxisCylinderMesh(app);

  const root = new Entity("sogsAxes", app);
  gsplatEntity.addChild(root);

  for (const c of AXIS_CONFIGS) {
    const mat = axisMaterial(c.rgb);
    const ent = new Entity(c.name, app);
    ent.setLocalEulerAngles(c.ex, c.ey, c.ez);
    ent.setLocalPosition(c.px, c.py, c.pz);
    const mi = new MeshInstance(mesh, mat, ent);
    mi.drawOrder = 0xffffff;
    ent.addComponent("render", {
      meshInstances: [mi],
      castShadows: false,
      receiveShadows: false,
    });
    setAxisGuideRenderLayer(ent);
    root.addChild(ent);
  }

  window.__sogsAxesRoot = root;
  root.enabled = !!window.__sogsGuidesEnabled;
}

/**
 * RGB XYZ cylinders at world origin (0,0,0), identity rotation — true world +X/+Y/+Z, independent of gsplat transform.
 */
function setupWorldAxesGuides(app) {
  if (window.__sogsWorldAxesRoot) {
    try {
      window.__sogsWorldAxesRoot.destroy();
    } catch {
      /* ignore */
    }
    window.__sogsWorldAxesRoot = null;
  }

  const mesh = buildAxisCylinderMesh(app);
  const root = new Entity("sogsWorldAxes", app);
  root.setLocalPosition(0, 0, 0);
  root.setLocalEulerAngles(0, 0, 0);
  app.root.addChild(root);

  for (const c of AXIS_CONFIGS) {
    const mat = axisMaterial(c.rgb);
    const ent = new Entity(`${c.name}World`, app);
    ent.setLocalEulerAngles(c.ex, c.ey, c.ez);
    ent.setLocalPosition(c.px, c.py, c.pz);
    const mi = new MeshInstance(mesh, mat, ent);
    mi.drawOrder = 0xffffff;
    ent.addComponent("render", {
      meshInstances: [mi],
      castShadows: false,
      receiveShadows: false,
    });
    setAxisGuideRenderLayer(ent);
    root.addChild(ent);
  }

  window.__sogsWorldAxesRoot = root;
  root.enabled = !!window.__sogsWorldGuidesEnabled;
}

function syncWorldAxesGuides(app) {
  const g = app.root.findByName("gsplat");
  if (!g) {
    return;
  }
  if (window.__sogsWorldGuidesEnabled && !window.__sogsWorldAxesRoot) {
    setupWorldAxesGuides(app);
  }
  if (window.__sogsWorldAxesRoot) {
    window.__sogsWorldAxesRoot.enabled = !!window.__sogsWorldGuidesEnabled;
  }
  app.renderNextFrame = true;
}

function syncSogsAxesGuides(app) {
  const g = app.root.findByName("gsplat");
  if (!g) {
    return;
  }
  if (window.__sogsGuidesEnabled && !window.__sogsAxesRoot) {
    setupSogsAxesGuides(app, g);
  }
  if (window.__sogsAxesRoot) {
    window.__sogsAxesRoot.enabled = !!window.__sogsGuidesEnabled;
  }
  app.renderNextFrame = true;
}

document.addEventListener("DOMContentLoaded", async () => {
  const bootOptions = getBootOptions();
  postBootEvent("supersplat:bootStart", { quality: bootOptions.quality });
  const { config, configReady, settings } = window.sse;
  try {
    const resolvedConfig = await Promise.resolve(configReady ?? config);
    const bootConfig = {
      ...resolvedConfig,
      lowQuality: bootOptions.lowQuality
    };
    const { poster } = bootConfig;

    if (poster) {
      const element = document.getElementById("poster");
      element.style.backgroundImage = `url(${poster.src})`;
      element.style.display = "block";
      element.style.filter = "blur(40px)";
    }

    const [appElement, cameraElement, settingsJson] = await Promise.all([
      document.querySelector("pc-app").ready(),
      document.querySelector('pc-entity[name="camera"]').ready(),
      settings,
    ]);

    const app = appElement.app;
    const camera = cameraElement.entity;
    const viewer = await withTimeout(main(app, camera, settingsJson, bootConfig), MAIN_BOOT_TIMEOUT_MS, "main");

    if (bootOptions.lowQuality) {
      try {
        appElement.highResolution = false;
      } catch {
        /* ignore */
      }
      try {
        viewer.global.state.hqMode = false;
      } catch {
        /* ignore */
      }
      try {
        app.graphicsDevice.maxPixelRatio = 1;
      } catch {
        /* ignore */
      }
    }

    window.__sogsCtx = { viewer, app, camera };

    await waitForValue(() => app.root.findByName("gsplat"), "gsplat");
    await waitForValue(() => viewer.cameraManager, "cameraManager");

    setupCameraManagerBridge(viewer.cameraManager);
    /** Primary pointer + pointermove pan was removed: it fought orbit/touch and caused bounce. */
    window.__sogsSplatXzDragReady = true;

    window.addEventListener("message", (event) => {
      const d = event.data;
      if (!d || typeof d !== "object") {
        return;
      }
      if (d.type === "sogs:apply") {
        const g = app.root.findByName("gsplat");
        if (!g) {
          return;
        }
        if (Array.isArray(d.position) && d.position.length === 3) {
          g.setLocalPosition(d.position[0], d.position[1], d.position[2]);
        }
        if (Array.isArray(d.rotation) && d.rotation.length === 3) {
          g.setLocalEulerAngles(d.rotation[0], d.rotation[1], d.rotation[2]);
        }
        if (typeof d.scale === "number" && Number.isFinite(d.scale)) {
          g.setLocalScale(d.scale, d.scale, d.scale);
        }
        if (typeof d.fov === "number" && Number.isFinite(d.fov)) {
          window.__sogsUserFov = d.fov;
        }
        app.renderNextFrame = true;
        postSogsState();
      }
      if (d.type === "sogs:guides") {
        window.__sogsGuidesEnabled = !!d.enabled;
        syncSogsAxesGuides(app);
      }
      if (d.type === "sogs:worldGuides") {
        window.__sogsWorldGuidesEnabled = !!d.enabled;
        syncWorldAxesGuides(app);
      }
      if (d.type === "sogs:requestState") {
        postSogsState();
      }
      if (d.type === "sogs:cameraLookAt") {
        window.__sogsCameraPose = {
          position: d.position,
          target: d.target,
          fov: d.fov,
        };
        app.renderNextFrame = true;
      }
      if (d.type === "sogs:cameraMode") {
        const scripted = d.mode === "scripted" || d.scripted === true;
        window.__sogsScriptedCamera = !!scripted;
        app.renderNextFrame = true;
      }
      if (d.type === "sogs:cameraBounds") {
        window.__sogsCameraYMin =
          typeof d.yMin === "number" && Number.isFinite(d.yMin) ? d.yMin : null;
        window.__sogsCameraMaxRadius =
          typeof d.maxRadiusFromOrigin === "number" && Number.isFinite(d.maxRadiusFromOrigin) && d.maxRadiusFromOrigin > 0
            ? d.maxRadiusFromOrigin
            : null;
        app.renderNextFrame = true;
      }
    });

    /** Tell parent to exit scripted tour / auto-orbit when the user grabs the view (orbit, zoom, touch). */
    const notifyUserInteraction = () => {
      if (window.__sogsScriptedCamera) {
        window.parent.postMessage({ type: "sogs:userInteraction" }, "*");
      }
    };
    for (const ev of ["pointerdown", "wheel", "touchstart"]) {
      window.addEventListener(ev, notifyUserInteraction, { capture: true, passive: true });
    }
    postBootEvent("supersplat:bridgeReady", { quality: bootOptions.quality });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage = message.startsWith("timeout:") ? message.slice("timeout:".length) : "unknown";
    console.error("SOGS boot failed", error);
    postBootEvent("supersplat:bootError", {
      quality: bootOptions.quality,
      stage,
      message,
    });
  }
});
