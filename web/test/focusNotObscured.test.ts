// Keyboard pass (Sat 23:30) regressions: focus must not hide under the sticky bars, and closing the
// "hold up to add" sheet must hand focus back instead of dropping it on <body>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");
const ADD = readFileSync(resolve(HERE, "../src/components/AddSheet.tsx"), "utf8");
const px = (re: RegExp) => {
  const m = re.exec(CSS);
  assert.ok(m, `missing ${re}`);
  return m[1].match(/(\d+)px/g)!.reduce((a, x) => a + parseInt(x), 0);
};

test("scroll-padding keeps focused controls above the sticky tab bar and the Start/Stop button (WCAG 2.4.11)", () => {
  const tabsH = Number(/\.tabs button \{[^}]*min-height: (\d+)px/.exec(CSS)?.[1]);
  assert.ok(tabsH >= 56);
  assert.ok(px(/html:has\(\.tabs\) \{\s*scroll-padding-bottom: calc\(([^;]+)\);/) >= tabsH + 2, "padding covers the tab bar");
  assert.ok(px(/html:has\(\.tabs\):has\(\.bigbtn-wrap\) \{\s*scroll-padding-bottom: calc\(([^;]+)\);/) >= 66 + 139, "padding covers tab bar + big button");
});

test("AddSheet restores focus on close (React detaches the dialog before close(), so the browser can't)", () => {
  assert.match(ADD, /const prev = document\.activeElement/);
  assert.match(ADD, /if \(prev\?\.isConnected\) prev\.focus\(\);/);
  assert.match(ADD, /querySelector<HTMLElement>\("#ask, h1\[tabindex\]"\)\?\.focus\(\)/, "fallback when the opener is gone");
});
