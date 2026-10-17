/**
 * The map with a trackpad: a pinch zooms at the fingers, a two-finger scroll pans (and is not taken for a mouse wheel),
 * Safari's gesture events work, and "Wheel: Auto / Zooms / Scrolls" is the override when the guess is wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BURST_MS, classifyWheel } from "../src/panel/public/wheel-kind.js";
import { chromium, openMap } from "./helpers/map-page.ts";

const browserType = await chromium();
const skip = !browserType && "needs Playwright Chromium";

const ev = (over: Partial<Parameters<typeof classifyWheel>[0]> = {}) => ({
  ctrlKey: false,
  shiftKey: false,
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ...over,
});
const fresh = () => ({ at: 0, kind: null as "zoom" | "pan" | null });

test("classifyWheel: pinch, Shift, line mode, a full notch and sideways / fractional / small movement", () => {
  const k = (
    e: ReturnType<typeof ev>,
    mode: "auto" | "zoom" | "scroll" = "auto",
    st = fresh(),
    now = 1000,
  ) => classifyWheel(e, st, mode, now);
  assert.equal(k(ev({ ctrlKey: true, deltaY: -3 })), "pinch", "Ctrl + wheel is what a pinch sends");
  assert.equal(
    k(ev({ ctrlKey: true, deltaY: -100 }), "scroll"),
    "pinch",
    "a pinch zooms in every mode",
  );
  assert.equal(k(ev({ shiftKey: true, deltaY: 100 })), "pan");
  assert.equal(k(ev({ deltaY: 100 })), "zoom", "a notch of 100 is a mouse wheel");
  assert.equal(k(ev({ deltaY: -120 })), "zoom", "so is 120");
  assert.equal(k(ev({ deltaMode: 1, deltaY: 3 })), "zoom", "lines: a mouse wheel in Firefox");
  assert.equal(k(ev({ deltaY: 4 })), "pan", "a small first delta is two fingers");
  assert.equal(k(ev({ deltaY: 12.5 })), "pan", "a fractional delta is two fingers");
  assert.equal(k(ev({ deltaX: 6, deltaY: 40 })), "pan", "sideways movement is two fingers");
  // the override
  assert.equal(k(ev({ deltaY: 100 }), "scroll"), "pan", "scroll mode never zooms from the wheel");
  assert.equal(k(ev({ deltaY: 4 }), "zoom"), "zoom", "zoom mode always zooms from the wheel");
  assert.equal(k(ev({ deltaY: 4, shiftKey: true }), "zoom"), "pan", "Shift scrolls in every mode");
});

test("classifyWheel: the first event of a gesture decides and the burst keeps it; a pause starts a new gesture", () => {
  const st = fresh();
  // a trackpad scroll: starts small, then grows and reaches notch size while the fingers keep moving
  assert.equal(classifyWheel(ev({ deltaY: 3 }), st, "auto", 1000), "pan");
  assert.equal(
    classifyWheel(ev({ deltaY: 120 }), st, "auto", 1000 + BURST_MS - 10),
    "pan",
    "still the same gesture",
  );
  assert.equal(classifyWheel(ev({ deltaY: 30 }), st, "auto", 1000 + 2 * BURST_MS - 20), "pan");
  // a pause, then a mouse notch: a new gesture
  assert.equal(classifyWheel(ev({ deltaY: 100 }), st, "auto", 3000), "zoom");
  assert.equal(
    classifyWheel(ev({ deltaY: 100 }), st, "auto", 3000 + 20),
    "zoom",
    "a fast second notch is still zoom",
  );
});

test(
  "trackpad in the browser: a two-finger scroll pans and does not zoom; a pinch zooms at the fingers; Safari's gestures too",
  { skip, timeout: 90_000 },
  async () => {
    const { page, level, canvas, under, errors, close } = await openMap();
    try {
      // zoom in with the keys so there is something to scroll
      for (let i = 0; i < 4; i++) await page.keyboard.press("+");
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) >= 159",
      );
      await page.waitForTimeout(200);
      const c = await canvas();
      const px = c.x + c.w * 0.5;
      const py = c.y + c.h * 0.5;
      await page.mouse.move(px, py);
      // two fingers (small deltas, one event after a pause): the view scrolls, the zoom does not change
      const z0 = await level();
      const before = await canvas();
      await page.mouse.wheel(30, 24);
      await page.waitForTimeout(250);
      const after = await canvas();
      assert.equal(await level(), z0, "a two-finger scroll is not a zoom");
      assert.ok(after.left > before.left || after.top > before.top, "the view panned");
      // a synthetic fractional delta (what a precision touchpad sends) is left to the browser: not prevented, no zoom
      const prevented = await page.evaluate(`(() => {
        const c = document.querySelector('.ds-map-canvas');
        const e = new WheelEvent('wheel', { deltaY: 9.5, deltaX: 0, bubbles: true, cancelable: true, clientX: ${px}, clientY: ${py} });
        c.dispatchEvent(e);
        return e.defaultPrevented;
      })()`);
      assert.equal(
        prevented,
        false,
        "a fractional delta is a trackpad pan: the browser scrolls it",
      );
      assert.equal(await level(), z0);
      await page.waitForTimeout(150);
      // a pinch (Ctrl + small deltas) zooms at the fingers, wherever the mode is
      await page.click("[data-wheel=scroll]");
      await page.mouse.move(px, py);
      const p0 = await under(px, py);
      await page.keyboard.down("Control");
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 8); // pinch out: zoom out
      await page.keyboard.up("Control");
      await page.waitForTimeout(200);
      assert.ok((await level()) < z0, "a pinch out zooms out");
      const p1 = await under(px, py);
      assert.ok(
        Math.abs(p1.x - p0.x) < 4 && Math.abs(p1.y - p0.y) < 4,
        `the point between the fingers stayed: ${JSON.stringify([p0, p1])}`,
      );
      // Safari: gesture events carry a cumulative scale (from 100 %, so the 160 % limit is out of the way)
      await page.click("[data-act=reset]");
      await page.mouse.move(px, py);
      await page.waitForFunction(
        "document.querySelector('[data-zoom]').textContent.trim() === '100%'",
      );
      const z1 = await level();
      await page.evaluate(`(() => {
        const c = document.querySelector('.ds-map-canvas');
        const fire = (type, scale) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { scale, clientX: ${px}, clientY: ${py} }); c.dispatchEvent(e); };
        fire('gesturestart', 1); fire('gesturechange', 1.1); fire('gesturechange', 1.25); fire('gestureend', 1.25);
      })()`);
      await page.waitForTimeout(200);
      const z2 = await level();
      assert.ok(z2 > z1, `a Safari pinch out zooms in (${z1} → ${z2})`);
      assert.ok(Math.abs(z2 / z1 - 1.25) < 0.05, `by the gesture's scale (${z2 / z1})`);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "Wheel: Auto / Zooms / Scrolls: the override changes what a wheel does, is remembered, and never touches a pinch",
  { skip, timeout: 90_000 },
  async () => {
    const { page, level, canvas, errors, close } = await openMap();
    try {
      assert.equal(
        await page.getAttribute("[data-wheel=auto]", "aria-pressed"),
        "true",
        "Auto by default",
      );
      const c = await canvas();
      await page.mouse.move(c.x + c.w * 0.5, c.y + c.h * 0.5);
      // Scrolls: even a full notch scrolls (zoom in first, so there is something to scroll)
      await page.click("[data-wheel=scroll]");
      for (let i = 0; i < 4; i++) await page.keyboard.press("+");
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) >= 159",
      );
      await page.mouse.move(c.x + c.w * 0.5, c.y + c.h * 0.5);
      const z = await level();
      const t0 = (await canvas()).top;
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(250);
      assert.equal(await level(), z, "a notch does not zoom in Scrolls mode");
      assert.ok((await canvas()).top > t0, "it scrolls");
      // Zooms: even small deltas zoom
      await page.click("[data-wheel=zoom]");
      await page.mouse.move(c.x + c.w * 0.5, c.y + c.h * 0.5);
      await page.mouse.wheel(0, 6);
      await page.waitForTimeout(250);
      assert.ok((await level()) < z, "small deltas zoom in Zooms mode");
      // remembered across a reload
      await page.reload();
      await page.waitForSelector(".ds-map .ds-node");
      assert.equal(await page.getAttribute("[data-wheel=zoom]", "aria-pressed"), "true");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
