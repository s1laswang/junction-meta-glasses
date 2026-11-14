export interface FocusableElement {
  tagName?: string;
  focus?: (options?: { preventScroll?: boolean }) => void;
  getAttribute?: (name: string) => string | null;
}

export type ModalTabEventLike = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
  preventDefault?: () => void;
};

type InternalStyleLike = {
  display?: unknown;
  visibility?: unknown;
};

type InternalDocLike = {
  activeElement?: unknown;
};

type InternalElement = {
  nodeType?: unknown;
  tagName?: unknown;
  nodeName?: unknown;
  tabIndex?: unknown;
  disabled?: unknown;
  hidden?: unknown;
  inert?: unknown;
  ariaHidden?: unknown;
  type?: unknown;
  href?: unknown;
  controls?: unknown;
  isContentEditable?: unknown;
  contentEditable?: unknown;
  style?: InternalStyleLike | null;
  parentElement?: unknown;
  parentNode?: unknown;
  ownerDocument?: InternalDocLike | null;
  children?: Iterable<unknown> | ArrayLike<unknown> | null;
  childNodes?: Iterable<unknown> | ArrayLike<unknown> | null;
  getAttribute?: (name: string) => string | null;
  hasAttribute?: (name: string) => boolean;
  querySelectorAll?: (selector: string) => Iterable<unknown> | ArrayLike<unknown>;
  focus?: (options?: { preventScroll?: boolean }) => void;
};

const NATIVE_TABBABLE_TAGS = new Set([
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "SUMMARY",
  "IFRAME"
]);

const DISABLEABLE_TAGS = new Set([
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "OPTGROUP",
  "OPTION",
  "FIELDSET"
]);

function getTagName(node: InternalElement): string {
  if (typeof node.tagName === "string" && node.tagName.trim().length > 0) {
    return node.tagName.trim().toUpperCase();
  }
  if (
    typeof node.nodeName === "string" &&
    node.nodeName.trim().length > 0 &&
    !node.nodeName.trim().startsWith("#")
  ) {
    return node.nodeName.trim().toUpperCase();
  }
  return "";
}

function isElementObject(value: unknown): value is InternalElement {
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as InternalElement;
  if (typeof node.nodeType === "number" && node.nodeType !== 1) {
    return false;
  }
  return getTagName(node).length > 0;
}

function getAttr(node: InternalElement, name: string): string | null {
  if (typeof node.getAttribute === "function") {
    const direct = node.getAttribute(name);
    if (typeof direct === "string") {
      return direct;
    }
    const lower = name.toLowerCase();
    if (lower !== name) {
      const fallback = node.getAttribute(lower);
      if (typeof fallback === "string") {
        return fallback;
      }
    }
  }
  return null;
}

function hasAttr(node: InternalElement, name: string): boolean {
  if (typeof node.hasAttribute === "function") {
    if (node.hasAttribute(name)) {
      return true;
    }
    const lower = name.toLowerCase();
    if (lower !== name && node.hasAttribute(lower)) {
      return true;
    }
  }
  return getAttr(node, name) !== null;
}

function toArray(collection: Iterable<unknown> | ArrayLike<unknown>): unknown[] {
  return Array.from(collection as ArrayLike<unknown>);
}

function getDirectElementChildren(node: InternalElement): InternalElement[] {
  if (node.children !== null && node.children !== undefined) {
    return toArray(node.children).filter(isElementObject);
  }
  if (node.childNodes !== null && node.childNodes !== undefined) {
    return toArray(node.childNodes).filter(isElementObject);
  }
  return [];
}

function isSubtreeExcludedFromA11yAndFocus(node: InternalElement): boolean {
  if (node.hidden === true || node.hidden === "until-found" || hasAttr(node, "hidden")) {
    return true;
  }
  if (node.inert === true || hasAttr(node, "inert")) {
    return true;
  }
  const ariaHiddenAttr = getAttr(node, "aria-hidden");
  if (ariaHiddenAttr !== null && ariaHiddenAttr.trim().toLowerCase() === "true") {
    return true;
  }
  if (
    node.ariaHidden === true ||
    (typeof node.ariaHidden === "string" && node.ariaHidden.trim().toLowerCase() === "true")
  ) {
    return true;
  }
  const style = node.style;
  if (style && typeof style === "object") {
    if (typeof style.display === "string" && style.display.trim().toLowerCase() === "none") {
      return true;
    }
  }
  if (
    typeof window !== "undefined" &&
    typeof Element !== "undefined" &&
    node instanceof Element &&
    typeof window.getComputedStyle === "function"
  ) {
    const computed = window.getComputedStyle(node);
    if (computed.display === "none") {
      return true;
    }
  }
  return false;
}

function isVisibilityHiddenOnSelfOrAncestor(node: InternalElement): boolean {
  const visited = new Set<unknown>();
  let cursor: unknown = node;
  while (isElementObject(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    const style = cursor.style;
    if (style && typeof style === "object" && typeof style.visibility === "string") {
      const vis = style.visibility.trim().toLowerCase();
      if (vis === "hidden" || vis === "collapse") {
        return true;
      }
      if (vis === "visible") {
        return false;
      }
    }
    if (
      typeof window !== "undefined" &&
      typeof Element !== "undefined" &&
      cursor instanceof Element &&
      typeof window.getComputedStyle === "function"
    ) {
      const computed = window.getComputedStyle(cursor);
      if (computed.visibility === "hidden" || computed.visibility === "collapse") {
        return true;
      }
      if (computed.visibility === "visible") {
        return false;
      }
    }
    cursor = cursor.parentElement ?? cursor.parentNode ?? null;
  }
  return false;
}

function isHiddenOrInertWithAncestors(node: InternalElement): boolean {
  const visited = new Set<unknown>();
  let cursor: unknown = node;
  while (isElementObject(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    if (isSubtreeExcludedFromA11yAndFocus(cursor)) {
      return true;
    }
    cursor = cursor.parentElement ?? cursor.parentNode ?? null;
  }
  return isVisibilityHiddenOnSelfOrAncestor(node);
}

function isFirstLegendOfFieldset(fieldset: InternalElement, candidate: InternalElement): boolean {
  for (const child of getDirectElementChildren(fieldset)) {
    if (getTagName(child) === "LEGEND") {
      return child === candidate;
    }
  }
  return false;
}

function isDisabledControl(node: InternalElement, tag: string): boolean {
  if (node.disabled === true) {
    return true;
  }
  if (DISABLEABLE_TAGS.has(tag) && hasAttr(node, "disabled")) {
    return true;
  }
  if (!DISABLEABLE_TAGS.has(tag)) {
    return false;
  }

  const visited = new Set<unknown>();
  let childCursor: InternalElement = node;
  let parentCursor: unknown = node.parentElement ?? node.parentNode ?? null;

  while (isElementObject(parentCursor) && !visited.has(parentCursor)) {
    visited.add(parentCursor);
    const parentTag = getTagName(parentCursor);
    if (
      parentTag === "FIELDSET" &&
      (parentCursor.disabled === true || hasAttr(parentCursor, "disabled"))
    ) {
      if (!isFirstLegendOfFieldset(parentCursor, childCursor)) {
        return true;
      }
    }
    childCursor = parentCursor;
    parentCursor = parentCursor.parentElement ?? parentCursor.parentNode ?? null;
  }

  return false;
}

function parseAttrTabIndex(node: InternalElement): number | null {
  const raw = getAttr(node, "tabindex");
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function readPropTabIndex(node: InternalElement): number | null {
  if (typeof node.tabIndex === "number" && Number.isFinite(node.tabIndex)) {
    return Math.trunc(node.tabIndex);
  }
  return null;
}

function isContentEditableElement(node: InternalElement): boolean {
  if (node.isContentEditable === true) {
    return true;
  }
  const rawAttr = getAttr(node, "contenteditable");
  const rawProp = typeof node.contentEditable === "string" ? node.contentEditable : null;
  const raw = rawAttr ?? rawProp;
  if (raw === null) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "plaintext-only";
}

function resolveTabOrderRank(node: InternalElement): number {
  const attrIdx = parseAttrTabIndex(node);
  if (attrIdx !== null) {
    return attrIdx > 0 ? attrIdx : 0;
  }
  const propIdx = readPropTabIndex(node);
  if (propIdx !== null && propIdx > 0) {
    return propIdx;
  }
  return 0;
}

export function isFocusableElement(el: unknown): boolean {
  if (!isElementObject(el)) {
    return false;
  }

  const tag = getTagName(el);

  if (tag === "SVG") {
    const focusableAttr = getAttr(el, "focusable");
    if (focusableAttr !== null && focusableAttr.trim().toLowerCase() === "false") {
      return false;
    }
  }

  if (tag === "INPUT") {
    const rawType =
      getAttr(el, "type") ?? (typeof el.type === "string" ? el.type : "");
    if (rawType.trim().toLowerCase() === "hidden") {
      return false;
    }
  }

  if (isDisabledControl(el, tag)) {
    return false;
  }

  if (isHiddenOrInertWithAncestors(el)) {
    return false;
  }

  const attrTabIndex = parseAttrTabIndex(el);
  const propTabIndex = readPropTabIndex(el);

  if (attrTabIndex !== null) {
    return attrTabIndex >= 0;
  }

  if (propTabIndex !== null && propTabIndex < 0) {
    return false;
  }

  if (NATIVE_TABBABLE_TAGS.has(tag)) {
    return true;
  }

  if (tag === "A" || tag === "AREA") {
    return (
      hasAttr(el, "href") ||
      (typeof el.href === "string" && el.href.trim().length > 0)
    );
  }

  if (tag === "AUDIO" || tag === "VIDEO") {
    return hasAttr(el, "controls") || el.controls === true;
  }

  if (isContentEditableElement(el)) {
    return true;
  }

  if (propTabIndex !== null && propTabIndex >= 0) {
    return true;
  }

  return false;
}

function collectDescendantsDepthFirst(
  root: InternalElement,
  inheritedFieldsetDisabled: boolean,
  out: InternalElement[],
  visited: Set<unknown>
): void {
  const children = getDirectElementChildren(root);
  const rootTag = getTagName(root);
  const rootIsDisabledFieldset =
    rootTag === "FIELDSET" && (root.disabled === true || hasAttr(root, "disabled"));
  let seenFirstLegend = false;

  for (const child of children) {
    if (visited.has(child)) {
      continue;
    }
    visited.add(child);

    if (isSubtreeExcludedFromA11yAndFocus(child)) {
      continue;
    }

    const childTag = getTagName(child);
    let childInheritedDisabled = inheritedFieldsetDisabled;
    if (rootIsDisabledFieldset) {
      if (childTag === "LEGEND" && !seenFirstLegend) {
        seenFirstLegend = true;
      } else {
        childInheritedDisabled = true;
      }
    }

    const blockedByInheritedFieldset =
      childInheritedDisabled && DISABLEABLE_TAGS.has(childTag);

    if (!blockedByInheritedFieldset && isFocusableElement(child)) {
      out.push(child);
    }

    collectDescendantsDepthFirst(child, childInheritedDisabled, out, visited);
  }
}

export function getTabbableElements(container: HTMLElement | null | undefined): HTMLElement[];
export function getTabbableElements<T extends FocusableElement = FocusableElement>(
  container:
    | { childNodes: ArrayLike<T> }
    | { children: ArrayLike<T> }
    | { querySelectorAll: (selector: string) => ArrayLike<T> }
    | FocusableElement
    | null
    | undefined
): T[];
export function getTabbableElements(container: unknown): FocusableElement[] {
  if (!container || typeof container !== "object") {
    return [];
  }

  const root = container as InternalElement;
  if (isElementObject(root) && isHiddenOrInertWithAncestors(root)) {
    return [];
  }

  let candidates: InternalElement[] = [];
  const hasTreeChildren =
    (root.children !== null && root.children !== undefined) ||
    (root.childNodes !== null && root.childNodes !== undefined);

  if (hasTreeChildren) {
    collectDescendantsDepthFirst(root, false, candidates, new Set<unknown>([root]));
  } else if (typeof root.querySelectorAll === "function") {
    candidates = toArray(root.querySelectorAll("*"))
      .filter(isElementObject)
      .filter((el) => isFocusableElement(el));
  }

  if (candidates.length <= 1) {
    return candidates as FocusableElement[];
  }

  const ranked = candidates.map((el, domOrder) => ({
    el,
    domOrder,
    rank: resolveTabOrderRank(el)
  }));

  if (!ranked.some((item) => item.rank > 0)) {
    return candidates as FocusableElement[];
  }

  ranked.sort((a, b) => {
    if (a.rank > 0 && b.rank > 0) {
      return a.rank !== b.rank ? a.rank - b.rank : a.domOrder - b.domOrder;
    }
    if (a.rank > 0) {
      return -1;
    }
    if (b.rank > 0) {
      return 1;
    }
    return a.domOrder - b.domOrder;
  });

  return ranked.map((item) => item.el as FocusableElement);
}

export function computeWrappedFocusIndex(
  count: number,
  currentIndex: number,
  shiftKey = false
): number {
  if (!Number.isFinite(count)) {
    return -1;
  }
  const total = Math.trunc(count);
  if (total <= 0) {
    return -1;
  }

  if (!Number.isFinite(currentIndex)) {
    return shiftKey ? total - 1 : 0;
  }
  const idx = Math.trunc(currentIndex);
  if (idx < 0 || idx >= total) {
    return shiftKey ? total - 1 : 0;
  }

  if (shiftKey) {
    return (idx - 1 + total) % total;
  }
  return (idx + 1) % total;
}

function findTabbableIndexFromNode(
  candidate: unknown,
  container: InternalElement,
  tabbables: readonly FocusableElement[]
): number {
  const visited = new Set<unknown>();
  let cursor: unknown = candidate;

  while (cursor && typeof cursor === "object" && !visited.has(cursor)) {
    if (cursor === container) {
      return -1;
    }
    const directIdx = tabbables.indexOf(cursor as FocusableElement);
    if (directIdx !== -1) {
      return directIdx;
    }
    visited.add(cursor);
    const elem = cursor as InternalElement;
    cursor = elem.parentElement ?? elem.parentNode ?? null;
  }

  return -1;
}

function resolveCurrentTabbableIndex(
  event: ModalTabEventLike,
  container: InternalElement,
  tabbables: readonly FocusableElement[]
): number {
  const ownerActive = container.ownerDocument?.activeElement;
  if (ownerActive === container) {
    return -1;
  }
  const ownerIdx = findTabbableIndexFromNode(ownerActive, container, tabbables);
  if (ownerIdx !== -1) {
    return ownerIdx;
  }

  const globalActive = typeof document !== "undefined" ? document.activeElement : null;
  if (globalActive && globalActive !== ownerActive) {
    if (globalActive === container) {
      return -1;
    }
    const globalIdx = findTabbableIndexFromNode(globalActive, container, tabbables);
    if (globalIdx !== -1) {
      return globalIdx;
    }
  }

  if (event.target === container) {
    return -1;
  }
  return findTabbableIndexFromNode(event.target, container, tabbables);
}

export function trapModalTabKey(
  event: ModalTabEventLike | null | undefined,
  container: FocusableElement | null | undefined
): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  if (event.defaultPrevented) {
    return false;
  }
  if (event.key !== "Tab") {
    return false;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  if (!container || typeof container !== "object") {
    return false;
  }

  const tabbables = getTabbableElements<FocusableElement>(container);
  if (tabbables.length === 0) {
    event.preventDefault?.();
    if (typeof container.focus === "function") {
      container.focus();
    }
    return true;
  }

  const currentIndex = resolveCurrentTabbableIndex(
    event,
    container as InternalElement,
    tabbables
  );
  const nextIndex = computeWrappedFocusIndex(
    tabbables.length,
    currentIndex,
    Boolean(event.shiftKey)
  );
  const nextTarget = tabbables[nextIndex];
  if (!nextTarget) {
    return false;
  }

  event.preventDefault?.();
  if (typeof nextTarget.focus === "function") {
    nextTarget.focus();
  }
  return true;
}
