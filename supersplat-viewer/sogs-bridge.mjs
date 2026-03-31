/**
 * Spaceport SOGS bridge: postMessage API for parent page + optional RGB world axes (mesh, not drawLine overlay).
 */
import { main } from "./index.js";
import {
  Color,
  CylinderGeometry,
  Entity,
  Mesh,
  MeshInstance,
  StandardMaterial,
  Vec3,
} from "https://esm.sh/playcanvas@2.13.2";

/** Parent-driven camera (position + look-at). When `sogs:cameraMode` is `scripted`, orbit input is skipped. */
const tmpFrom = new Vec3();
const tmpTo = new Vec3();
/** Orbit focus point for `sogs:cameraPose` (parent overlays / Three.js projection). */
const tmpFocus = new Vec3();

const AXIS_LEN = 45;
const AXIS_RADIUS = 0.28;

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

function copyRenderLayers(fromEntity, toEntity) {
  try {
    const layers = fromEntity.render?.layers;
    if (layers?.length && toEntity.render) {
      toEntity.render.layers = layers.slice();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Thin cylinders along local +X / +Y / +Z at the splat origin, parented to gsplat.
 * Renders in the normal forward pass (depth-tested), not as immediate drawLine overlay.
 */
function setupSogsAxesGuides(app, gsplatEntity) {
  if (window.__sogsAxesRoot) {
    try {
      window.__sogsAxesRoot.destroy();
    } catch {
      /* ignore */
    }
    window.__sogsAxesRoot = null;
  }

  const device = app.graphicsDevice;
  const geom = new CylinderGeometry({
    height: AXIS_LEN,
    radius: AXIS_RADIUS,
    heightSegments: 1,
    capSegments: 18,
  });
  const mesh = Mesh.fromGeometry(device, geom);

  const root = new Entity("sogsAxes");
  gsplatEntity.addChild(root);

  const configs = [
    { name: "sogsAxisX", ex: 0, ey: 0, ez: -90, px: AXIS_LEN / 2, py: 0, pz: 0, rgb: [0.95, 0.22, 0.18] },
    { name: "sogsAxisY", ex: 0, ey: 0, ez: 0, px: 0, py: AXIS_LEN / 2, pz: 0, rgb: [0.28, 0.92, 0.32] },
    { name: "sogsAxisZ", ex: 90, ey: 0, ez: 0, px: 0, py: 0, pz: AXIS_LEN / 2, rgb: [0.32, 0.52, 0.98] },
  ];

  for (const c of configs) {
    const mat = axisMaterial(c.rgb);
    const ent = new Entity(c.name);
    ent.setLocalEulerAngles(c.ex, c.ey, c.ez);
    ent.setLocalPosition(c.px, c.py, c.pz);
    const mi = new MeshInstance(mesh, mat, ent);
    ent.addComponent("render", {
      meshInstances: [mi],
      castShadows: false,
      receiveShadows: false,
    });
    copyRenderLayers(gsplatEntity, ent);
    root.addChild(ent);
  }

  window.__sogsAxesRoot = root;
  root.enabled = !!window.__sogsGuidesEnabled;
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
  const { config, configReady, settings } = window.sse;
  const resolvedConfig = await Promise.resolve(configReady ?? config);
  const { poster } = resolvedConfig;

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
  const viewer = await main(app, camera, settingsJson, resolvedConfig);

  window.__sogsCtx = { viewer, app, camera };

  const waitGsplat = () =>
    new Promise((resolve) => {
      const id = setInterval(() => {
        const e = app.root.findByName("gsplat");
        if (e) {
          clearInterval(id);
          resolve(e);
        }
      }, 30);
    });

  await waitGsplat();

  await new Promise((resolve) => {
    const id = setInterval(() => {
      if (viewer.cameraManager) {
        clearInterval(id);
        resolve(undefined);
      }
    }, 30);
  });

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
});
