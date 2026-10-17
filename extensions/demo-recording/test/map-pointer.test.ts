/**
 * The map with a mouse: the wheel zooms at the pointer (Shift + wheel and a sideways scroll still scroll, a pinch zooms),
 * and dragging the background pans, without ever starting from something you can press.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, openMap } from "./helpers/map-page.ts";

const browserType = await chromium();
const skip = !browserType && "needs Playwright Chromium";

test(
  "wheel: zooms at the pointer, a pinch zooms, Shift + wheel and a sideways scroll do not; the point under the pointer stays put",
  { skip, timeout: 90_000 },
  async () => {
    const { page, level, canvas, under, errors, close } = await openMap();
    try {
      const c = await canvas();
      const px = c.x + c.w * 0.6;
      const py = c.y + c.h * 0.5;
      await page.mouse.move(px, py);
      const point0 = await under(px, py);
      assert.equal(await level(), 100);
      await page.mouse.wheel(0, -100); // one notch up
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) === 120",
      );
      await page.waitForTimeout(150);
      const point1 = await under(px, py);
      assert.ok(
        Math.abs(point1.x - point0.x) < 3 && Math.abs(point1.y - point0.y) < 3,
        `the point under the pointer stayed: ${JSON.stringify(point0)} → ${JSON.stringify(point1)}`,
      );
      // two more notches and the same holds at 160 % (the limit)
      await page.mouse.wheel(0, -100);
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) >= 159",
      );
      await page.waitForTimeout(150);
      const point2 = await under(px, py);
      assert.ok(
        Math.abs(point2.x - point0.x) < 4 && Math.abs(point2.y - point0.y) < 4,
        JSON.stringify([point0, point2]),
      );
      // down zooms out
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) < 150",
      );
      // Shift + wheel and a sideways scroll leave the zoom alone
      const z = await level();
      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 100);
      await page.keyboard.up("Shift");
      await page.mouse.wheel(150, 20);
      await page.waitForTimeout(150);
      assert.equal(
        await level(),
        z,
        "Shift + wheel and a sideways scroll scroll, they do not zoom",
      );
      // a pinch (Ctrl + small deltas) zooms smoothly, in steps smaller than a notch
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -4);
      await page.keyboard.up("Control");
      await page.waitForTimeout(150);
      const pinched = await level();
      assert.ok(pinched >= z && pinched - z < 5, `a pinch is a small step (${z} → ${pinched})`);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "pan: dragging the background moves the view, nothing you can press starts a pan, a click without moving does nothing",
  { skip, timeout: 90_000 },
  async () => {
    const { page, level, canvas, errors, close } = await openMap();
    try {
      // zoom in so there is something to pan to
      for (let i = 0; i < 4; i++) await page.keyboard.press("+");
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) >= 159",
      );
      await page.waitForTimeout(200);
      const c0 = await canvas();
      assert.equal(c0.cursor, "grab", "the background invites a drag");
      // an empty spot: far from every node (the top-left corner below the headers)
      const empty = (await page.evaluate(`(() => {
        const c = document.querySelector('.ds-map-canvas');
        const r = c.getBoundingClientRect();
        const nodes = [...document.querySelectorAll('.ds-node')].map((n) => n.getBoundingClientRect());
        for (let y = r.top + 70; y < r.bottom - 30; y += 20)
          for (let x = r.left + 20; x < r.right - 40; x += 20)
            if (!nodes.some((n) => x > n.left - 6 && x < n.right + 6 && y > n.top - 6 && y < n.bottom + 6)) return { x, y };
        return null;
      })()`)) as { x: number; y: number } | null;
      assert.ok(empty, "an empty spot on the canvas");
      const e = empty as { x: number; y: number };
      const sel0 = await page.evaluate("location.hash");
      // a click without moving does nothing at all
      await page.mouse.move(e.x, e.y);
      await page.mouse.down();
      await page.mouse.up();
      assert.equal(await page.evaluate("location.hash"), sel0);
      assert.equal((await canvas()).left, c0.left);
      // a drag moves the view the opposite way, and says it is panning meanwhile
      await page.mouse.move(e.x, e.y);
      await page.mouse.down();
      await page.mouse.move(e.x - 120, e.y - 60, { steps: 6 });
      const mid = await canvas();
      assert.equal(mid.panning, "true");
      assert.equal(mid.cursor, "grabbing");
      await page.mouse.up();
      const c1 = await canvas();
      assert.equal(c1.panning, null);
      assert.ok(
        c1.left > c0.left + 100 && c1.top > c0.top + 40,
        `scrolled ${c0.left},${c0.top} → ${c1.left},${c1.top}`,
      );
      // dragging back the other way returns (clamped at the edges)
      await page.mouse.move(e.x, e.y);
      await page.mouse.down();
      await page.mouse.move(e.x + 400, e.y + 300, { steps: 6 });
      await page.mouse.up();
      const c2 = await canvas();
      assert.ok(c2.left < c1.left && c2.top < c1.top);
      assert.equal(await page.evaluate("location.hash"), sel0, "panning never changes the address");
      // a press that starts on a version does not pan, and still selects it
      const node = (await page.locator(".ds-node[data-id='vo:1']").boundingBox()) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const before = await canvas();
      await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
      await page.mouse.down();
      await page.mouse.move(node.x + node.width / 2 - 80, node.y + node.height / 2 - 40, {
        steps: 4,
      });
      await page.mouse.up();
      const after = await canvas();
      assert.equal(after.left, before.left, "a drag that starts on a version does not pan");
      // a plain click on a version selects it
      await page.click(".ds-node[data-id='vo:1']");
      await page.waitForFunction("location.hash.includes('sel=vo')");
      // the zoom is untouched by all of it
      assert.ok((await level()) >= 159);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
