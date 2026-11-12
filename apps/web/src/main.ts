import { formatModelError, noModelResponseMessage } from "./model-errors.js";
import { getNavigationDirection, getStaggerTiming, NavigationMotion, navigationMotion, type NavigationDirection } from "./navigation-motion.js";

interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  startedAt: string;
  uptimeMs: number;
  checkedAt: string;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
}

const refreshButton = getElement<HTMLButtonElement>("refresh-button");
const statusLabel = getElement<HTMLElement>("connection-label");
const statusDot = getElement<HTMLElement>("connection-dot");
const serverVersion = getElement<HTMLElement>("server-version");
const serverUptime = getElement<HTMLElement>("server-uptime");
const lastChecked = getElement<HTMLElement>("last-checked");
const refreshLabel = getElement<HTMLElement>("refresh-label");
const themeSelect = getElement<HTMLSelectElement>("theme-select");
const setupThemeSelect = getElement<HTMLSelectElement>("setup-theme-select");
const mainStatus = getElement<HTMLElement>("main-status");
const statusDescription = getElement<HTMLElement>("status-description");

type MenuPage = { label: string; path: string };
type MenuGroup = { label: string; id: string; children: MenuPage[] };
type MenuCategory = { label: string; items: (MenuPage | MenuGroup)[] };
const menu: MenuCategory[] = [
  { label: "概览", items: [{ label: "运行概况", path: "/overview/status" }] },
  { label: "模型", items: [{ label: "对话", path: "/model/chat" }, { label: "模型服务", id: "model-service", children: [{ label: "当前配置", path: "/model/service/config" }, { label: "连接测试", path: "/model/service/test" }] }] },
  { label: "扩展", items: [{ label: "已安装扩展", path: "/extensions/installed" }] },
  { label: "配置", items: [{ label: "基本设置", path: "/settings/general" }, { label: "服务设置", path: "/settings/server" }] },
];
const primaryNav = getElement<HTMLElement>("primary-nav");
const secondaryNav = getElement<HTMLElement>("secondary-nav");
const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
const menuToggle = getElement<HTMLButtonElement>("menu-toggle");
const pageTitle = getElement<HTMLElement>("page-title");
const breadcrumb = getElement<HTMLElement>("page-breadcrumb");
const sidebarHeading = getElement<HTMLElement>("sidebar-heading");
const menuToggleLabel = getElement<HTMLElement>("menu-toggle-label");
const pageStage = getElement<HTMLElement>("page-stage");
const navPages = Array.from(document.querySelectorAll<HTMLElement>(".nav-page"));
const expanded = new Set<string>();
const lastVisited = new Map<string, string>();
const routeStates = new Map<string, { scrollX: number; scrollY: number; sidebarScrollTop: number; focus?: HTMLElement }>();
const motion = new NavigationMotion();
const primaryIndicator = document.createElement("span");
primaryIndicator.className = "primary-indicator";
primaryIndicator.setAttribute("aria-hidden", "true");
const secondaryIndicator = document.createElement("span");
secondaryIndicator.className = "secondary-indicator";
secondaryIndicator.setAttribute("aria-hidden", "true");
const primaryLinks = new Map<MenuCategory, HTMLAnchorElement>();
let currentTitle = "运行概况";
let webTitle = "Stardust";
let currentPath = "";
let activeCategory: MenuCategory | null = null;
let pendingNavigationOrigin: "click" | null = null;
let activeNavigationToken = 0;
let navigationAnimating = false;

function pages(category: MenuCategory): MenuPage[] {
  return category.items.flatMap((item) => "children" in item ? item.children : [item]);
}
function visiblePageIndex(category: MenuCategory, path: string): number {
  let index = 0;
  for (const item of category.items) {
    if (!("children" in item)) {
      if (item.path === path) return index;
      index += 1;
      continue;
    }
    index += 1;
    for (const child of item.children) {
      if (child.path === path) return index;
      index += 1;
    }
  }
  return index;
}
function closeMenu(): void {
  sidebar.classList.remove("is-open");
  menuToggle.setAttribute("aria-expanded", "false");
}
function markNavigationIntent(path: string, event: MouseEvent): void {
  if (location.hash.slice(1) === path) {
    event.preventDefault();
    pageTitle.focus({ preventScroll: true });
    return;
  }
  pendingNavigationOrigin = "click";
}
function createPageLink(page: MenuPage, path: string, className: string, order: number): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = `#${page.path}`;
  link.className = className;
  link.textContent = page.label;
  link.dataset.transitionOrder = String(order);
  if (page.path === path) link.setAttribute("aria-current", "page");
  link.addEventListener("click", (event) => {
    closeMenu();
    markNavigationIntent(page.path, event);
  });
  return link;
}
function createPrimaryNavigation(): void {
  primaryNav.replaceChildren(primaryIndicator);
  for (const item of menu) {
    const link = document.createElement("a");
    link.href = `#${pages(item)[0]!.path}`;
    link.textContent = item.label;
    link.addEventListener("click", (event) => {
      closeMenu();
      markNavigationIntent(link.hash.slice(1), event);
    });
    primaryLinks.set(item, link);
    primaryNav.append(link);
  }
}
function setGroupExpanded(groupId: string, isExpanded: boolean, category: MenuCategory, path: string): void {
  if (isExpanded) expanded.add(groupId); else expanded.delete(groupId);
  const button = document.getElementById(`nav-toggle-${groupId}`) as HTMLButtonElement | null;
  const children = document.getElementById(`nav-children-${groupId}`) as HTMLDivElement | null;
  if (!button || !children) return;
  button.setAttribute("aria-expanded", String(isExpanded));
  const arrow = button.querySelector<HTMLElement>("[data-nav-arrow]");
  if (arrow) arrow.textContent = isExpanded ? "−" : "+";
  children.dataset.expanded = String(isExpanded);
  children.setAttribute("aria-hidden", String(!isExpanded));
  children.inert = !isExpanded;
  const currentChild = category.items.find((item): item is MenuGroup => "children" in item && item.id === groupId)?.children.some((child) => child.path === path);
  if (currentChild && !isExpanded) moveSecondaryIndicator(true, activeNavigationToken, button);
  if (currentChild && isExpanded) {
    const complete = (): void => moveSecondaryIndicator(true, activeNavigationToken);
    children.addEventListener("transitionend", (event) => {
      if (event.propertyName === "grid-template-rows") complete();
    }, { once: true });
    window.setTimeout(complete, navigationMotion.submenuDurationMs + 32);
  }
}
function createSecondaryNavigation(category: MenuCategory, path: string, animate: boolean, direction: NavigationDirection, token: number): Promise<boolean[]> {
  secondaryNav.replaceChildren(secondaryIndicator);
  let order = 0;
  for (const item of category.items) {
    if (!("children" in item)) {
      secondaryNav.append(createPageLink(item, path, "secondary-link", order++));
      continue;
    }
    const group = document.createElement("div");
    group.className = "nav-group";
    const button = document.createElement("button");
    button.type = "button";
    button.id = `nav-toggle-${item.id}`;
    button.className = "nav-group-toggle";
    button.dataset.transitionOrder = String(order++);
    button.setAttribute("aria-expanded", String(expanded.has(item.id)));
    button.setAttribute("aria-controls", `nav-children-${item.id}`);
    if (item.children.some((page) => page.path === path)) button.classList.add("has-current");
    const label = document.createElement("span"); label.textContent = item.label;
    const arrow = document.createElement("span"); arrow.dataset.navArrow = "true"; arrow.textContent = expanded.has(item.id) ? "−" : "+"; arrow.setAttribute("aria-hidden", "true");
    button.append(label, arrow);
    button.addEventListener("click", () => {
      setGroupExpanded(item.id, !expanded.has(item.id), category, currentPath);
      button.focus({ preventScroll: true });
      moveSecondaryIndicator(true, activeNavigationToken);
    });
    group.append(button);
    const children = document.createElement("div");
    children.id = `nav-children-${item.id}`;
    children.className = "nav-children";
    children.dataset.expanded = String(expanded.has(item.id));
    children.setAttribute("aria-hidden", String(!expanded.has(item.id)));
    children.inert = !expanded.has(item.id);
    const inner = document.createElement("div");
    inner.className = "nav-children-inner";
    for (const page of item.children) inner.append(createPageLink(page, path, "secondary-link child-link", order++));
    children.append(inner);
    group.append(children);
    secondaryNav.append(group);
  }
  const sideItems = Array.from(secondaryNav.querySelectorAll<HTMLElement>("[data-transition-order]"));
  const entering = animate ? animateElements(sideItems, "enter", direction, "x", token, navigationMotion.sidebarEnterPx, true) : Promise.resolve([]);
  moveSecondaryIndicator(animate, token);
  return entering;
}
function updateSecondarySelection(category: MenuCategory, path: string, animate: boolean, token: number): void {
  secondaryNav.querySelectorAll<HTMLAnchorElement>("a.secondary-link").forEach((link) => {
    if (link.hash.slice(1) === path) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  for (const item of category.items) {
    if (!("children" in item)) continue;
    const currentChild = item.children.some((child) => child.path === path);
    document.getElementById(`nav-toggle-${item.id}`)?.classList.toggle("has-current", currentChild);
    if (currentChild && !expanded.has(item.id)) setGroupExpanded(item.id, true, category, path);
  }
  moveSecondaryIndicator(animate, token);
}
function movePrimaryIndicator(animate: boolean, token: number): Promise<boolean> {
  if (!activeCategory) return Promise.resolve(false);
  const link = primaryLinks.get(activeCategory);
  if (!link) return Promise.resolve(false);
  const navRect = primaryNav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const x = linkRect.left - navRect.left + primaryNav.scrollLeft;
  const width = linkRect.width;
  if (!animate || motion.isReducedMotion()) {
    primaryIndicator.style.transform = `translateX(${x}px)`;
    primaryIndicator.style.width = `${width}px`;
    return Promise.resolve(true);
  }
  const computed = getComputedStyle(primaryIndicator);
  const transform = computed.transform === "none" ? "translateX(0px)" : computed.transform;
  return motion.animate(primaryIndicator, [
    { transform, width: computed.width },
    { transform: `translateX(${x}px)`, width: `${width}px` },
  ], {
    token,
    duration: navigationMotion.navigationDurationMs,
    properties: ["transform", "width"],
    onFinish: () => { primaryIndicator.style.transform = `translateX(${x}px)`; primaryIndicator.style.width = `${width}px`; },
  });
}
function moveSecondaryIndicator(animate: boolean, token: number, forcedTarget?: HTMLElement): void {
  const selected = forcedTarget ?? secondaryNav.querySelector<HTMLElement>('[aria-current="page"]');
  if (!selected) return;
  const closedGroup = selected.closest<HTMLElement>(".nav-children[data-expanded='false']");
  const target = closedGroup?.previousElementSibling as HTMLElement | null ?? selected;
  const navRect = secondaryNav.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const y = rect.top - navRect.top + secondaryNav.scrollTop;
  const height = rect.height;
  if (!animate || motion.isReducedMotion()) {
    secondaryIndicator.style.transform = `translateY(${y}px)`;
    secondaryIndicator.style.height = `${height}px`;
    return;
  }
  const computed = getComputedStyle(secondaryIndicator);
  const transform = computed.transform === "none" ? "translateY(0px)" : computed.transform;
  void motion.animate(secondaryIndicator, [
    { transform, height: computed.height },
    { transform: `translateY(${y}px)`, height: `${height}px` },
  ], {
    token,
    duration: navigationMotion.navigationDurationMs,
    properties: ["transform", "height"],
    onFinish: () => { secondaryIndicator.style.transform = `translateY(${y}px)`; secondaryIndicator.style.height = `${height}px`; },
  });
}
function orderedTransitionItems(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-transition-order]"))
    .filter((element) => !element.hidden)
    .sort((left, right) => Number(left.dataset.transitionOrder) - Number(right.dataset.transitionOrder));
}
function motionTranslate(axis: "x" | "y", amount: number): string {
  return axis === "x" ? `${amount}px 0px` : `0px ${amount}px`;
}
function animateElements(elements: HTMLElement[], mode: "enter" | "exit", direction: NavigationDirection, axis: "x" | "y", token: number, distance: number, initialize: boolean): Promise<boolean[]> {
  const selected = [...new Set(elements)];
  return Promise.all(selected.map((element, index) => {
    const timing = getStaggerTiming(index);
    const computed = getComputedStyle(element);
    let translate = computed.translate === "none" ? "0px 0px" : computed.translate;
    let opacity = computed.opacity;
    if (mode === "enter" && initialize) {
      translate = motionTranslate(axis, direction * distance);
      opacity = "0";
      element.style.translate = translate;
      element.style.opacity = opacity;
    }
    const targetTranslate = mode === "enter" ? "0px 0px" : motionTranslate(axis, -direction * distance);
    const targetOpacity = mode === "enter" ? "1" : "0";
    return motion.animate(element, [
      { translate, opacity },
      { translate: targetTranslate, opacity: targetOpacity },
    ], {
      token,
      duration: timing.duration,
      delay: timing.delay,
      properties: ["translate", "opacity"],
      onFinish: mode === "enter" ? () => { element.style.removeProperty("translate"); element.style.removeProperty("opacity"); } : undefined,
    });
  }));
}
function createHeadingGhost(element: HTMLElement): HTMLElement {
  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.removeAttribute("tabindex");
  ghost.removeAttribute("data-transition-order");
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("transition-ghost");
  ghost.style.top = `${element.offsetTop}px`;
  ghost.style.left = `${element.offsetLeft}px`;
  ghost.style.width = `${element.offsetWidth}px`;
  element.parentElement!.append(ghost);
  return ghost;
}
function saveRouteState(path: string): void {
  if (!path) return;
  const previous = routeStates.get(path);
  const active = document.activeElement;
  const section = navPages.find((page) => page.dataset.page === path);
  const focus = active instanceof HTMLElement && section?.contains(active) ? active : previous?.focus;
  routeStates.set(path, { scrollX: window.scrollX, scrollY: window.scrollY, sidebarScrollTop: sidebar.scrollTop, ...(focus ? { focus } : {}) });
}
function restoreRouteState(path: string, origin: "click" | "history" | "programmatic" | "initial"): void {
  if (origin === "initial") return;
  const state = routeStates.get(path);
  const section = navPages.find((page) => page.dataset.page === path);
  if (origin === "history" && state?.focus?.isConnected && section?.contains(state.focus)) state.focus.focus({ preventScroll: true });
  else pageTitle.focus({ preventScroll: true });
  if (origin === "history" && state) {
    window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
    sidebar.scrollTop = state.sidebarScrollTop;
  }
}
function renderNavigation(origin: "click" | "history" | "programmatic" | "initial" = "history"): void {
  let path = location.hash.slice(1) || "/overview/status";
  let category = menu.find((item) => pages(item).some((page) => page.path === path));
  if (!category) {
    path = "/overview/status";
    category = menu[0]!;
    history.replaceState(null, "", `#${path}`);
  } else if (!location.hash) history.replaceState(null, "", `#${path}`);
  const page = pages(category).find((item) => item.path === path)!;
  if (currentPath === path && currentPath) {
    if (origin === "programmatic") pageTitle.focus({ preventScroll: true });
    return;
  }

  const previousPath = currentPath;
  const previousCategory = activeCategory;
  if (previousPath) saveRouteState(previousPath);
  const animate = Boolean(previousPath);
  const token = animate ? motion.begin() : activeNavigationToken;
  if (animate) activeNavigationToken = token;
  navigationAnimating = animate;
  const axis: "x" | "y" = previousCategory && previousCategory !== category ? "x" : "y";
  const fromIndex = axis === "x" && previousCategory ? menu.indexOf(previousCategory) : previousCategory ? visiblePageIndex(previousCategory, previousPath) : 0;
  const toIndex = axis === "x" ? menu.indexOf(category) : visiblePageIndex(category, path);
  const direction = getNavigationDirection(fromIndex, toIndex);
  const oldVisible = navPages.filter((section) => !section.hidden && section.dataset.page !== path);
  const targetSection = navPages.find((section) => section.dataset.page === path)!;
  const targetWasVisible = !targetSection.hidden;
  const stageHeight = pageStage.getBoundingClientRect().height;
  if (animate) pageStage.style.height = `${stageHeight}px`;
  const refreshWasVisible = !refreshButton.hidden;
  const headingGhosts = animate ? [
    ...Array.from(document.querySelectorAll<HTMLElement>(".heading-copy > .transition-ghost")),
    ...(pageTitle.textContent !== page.label ? [createHeadingGhost(pageTitle)] : []),
    ...(breadcrumb.textContent !== `STARDUST / ${category.label}` ? [createHeadingGhost(breadcrumb)] : []),
  ] : [];

  currentPath = path;
  activeCategory = category;
  currentTitle = page.label;
  lastVisited.set(category.label, path);
  for (const item of category.items) if ("children" in item && item.children.some((child) => child.path === path)) expanded.add(item.id);
  pageTitle.textContent = page.label;
  breadcrumb.textContent = `STARDUST / ${category.label}`;
  sidebarHeading.textContent = category.label;
  menuToggleLabel.textContent = `${category.label} / ${page.label}`;
  document.title = `${currentTitle} · ${webTitle}`;
  for (const section of navPages) {
    if (section.dataset.page === path) {
      section.hidden = false;
      section.removeAttribute("aria-hidden");
      section.inert = animate;
    } else if (!section.hidden) {
      section.setAttribute("aria-hidden", "true");
      section.inert = true;
    }
  }
  if (path === "/overview/status") refreshButton.hidden = false;
  primaryLinks.forEach((link, item) => {
    const targetPath = lastVisited.get(item.label) ?? pages(item)[0]!.path;
    link.href = `#${targetPath}`;
    if (item === category) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  });
  const sameCategory = previousCategory === category;
  const sideAnimation = !sameCategory
    ? createSecondaryNavigation(category, path, animate, direction, token)
    : (updateSecondarySelection(category, path, animate, token), Promise.resolve([]));
  closeMenu();

  if (!animate) {
    navPages.forEach((section) => { section.hidden = section.dataset.page !== path; section.inert = section.hidden; section.removeAttribute("aria-hidden"); });
    refreshButton.hidden = path !== "/overview/status";
    void movePrimaryIndicator(false, token);
    moveSecondaryIndicator(false, token);
    return;
  }

  const heading = document.querySelector<HTMLElement>(".page-heading")!;
  const enteringHeading = orderedTransitionItems(heading).filter((element) => element !== refreshButton || path === "/overview/status");
  const enteringContent = orderedTransitionItems(targetSection);
  const enterItems = [...enteringHeading, ...enteringContent, sidebarHeading, menuToggleLabel];
  sidebarHeading.dataset.transitionOrder = "0";
  menuToggleLabel.dataset.transitionOrder = "0";
  const exiting = [
    ...oldVisible.flatMap((section) => orderedTransitionItems(section)),
    ...headingGhosts,
    ...(refreshWasVisible && path !== "/overview/status" ? [refreshButton] : []),
  ];
  const entering = animateElements(enterItems, "enter", direction, axis, token, navigationMotion.contentEnterPx, !targetWasVisible);
  const exitingAnimation = animateElements(exiting, "exit", direction, axis, token, navigationMotion.contentExitPx, false);
  const primary = movePrimaryIndicator(true, token);
  if (!targetWasVisible) targetSection.style.opacity = "0";
  const fadePage = (section: HTMLElement, opacity: string): Promise<boolean> => motion.animate(section, [
    { opacity: getComputedStyle(section).opacity }, { opacity },
  ], { token, duration: navigationMotion.pageDurationMs, properties: ["opacity"] });
  const pageFades = [fadePage(targetSection, "1"), ...oldVisible.map((section) => fadePage(section, "0"))];
  const heightAnimation = motion.animate(pageStage, [
    { height: `${stageHeight}px` }, { height: `${targetSection.offsetHeight}px` },
  ], { token, duration: navigationMotion.pageDurationMs, properties: ["height"] });
  void Promise.all([entering, exitingAnimation, primary, sideAnimation, heightAnimation, ...pageFades]).then(() => {
    if (!motion.isCurrent(token)) return;
    for (const section of oldVisible) {
      section.hidden = true;
      section.removeAttribute("aria-hidden");
      section.style.removeProperty("opacity");
      section.querySelectorAll<HTMLElement>("[data-transition-order]").forEach((element) => { element.style.removeProperty("translate"); element.style.removeProperty("opacity"); });
    }
    for (const element of exiting) {
      if (element.classList.contains("transition-ghost")) element.remove();
      else { element.style.removeProperty("translate"); element.style.removeProperty("opacity"); }
    }
    targetSection.querySelectorAll<HTMLElement>("[data-transition-order]").forEach((element) => { element.style.removeProperty("translate"); element.style.removeProperty("opacity"); });
    targetSection.style.removeProperty("opacity");
    targetSection.inert = false;
    pageStage.style.removeProperty("height");
    sidebarHeading.style.removeProperty("translate"); sidebarHeading.style.removeProperty("opacity");
    menuToggleLabel.style.removeProperty("translate"); menuToggleLabel.style.removeProperty("opacity");
    refreshButton.hidden = path !== "/overview/status";
    navigationAnimating = false;
    void movePrimaryIndicator(false, token);
    moveSecondaryIndicator(false, token);
    restoreRouteState(path, origin);
  });
}
function setWebTitle(title: string): void {
  webTitle = title;
  getElement<HTMLElement>("settings-web-title").textContent = title;
  document.title = `${currentTitle} · ${webTitle}`;
}
function goToOverview(): void {
  history.replaceState(null, "", "#/overview/status");
  renderNavigation("programmatic");
}
menuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("is-open");
  menuToggle.setAttribute("aria-expanded", String(open));
});
window.addEventListener("hashchange", () => {
  const origin = pendingNavigationOrigin ?? "history";
  pendingNavigationOrigin = null;
  renderNavigation(origin);
});
document.addEventListener("focusin", (event) => {
  const target = event.target;
  const section = navPages.find((item) => item.dataset.page === currentPath);
  if (target instanceof HTMLElement && section?.contains(target)) {
    const previous = routeStates.get(currentPath);
    routeStates.set(currentPath, { ...previous, scrollX: window.scrollX, scrollY: window.scrollY, sidebarScrollTop: sidebar.scrollTop, focus: target });
  }
});
window.addEventListener("scroll", () => saveRouteState(currentPath), { passive: true });
const indicatorResize = new ResizeObserver(() => {
  if (!activeCategory || navigationAnimating) return;
  void movePrimaryIndicator(false, activeNavigationToken);
  moveSecondaryIndicator(false, activeNavigationToken);
});
indicatorResize.observe(primaryNav);
indicatorResize.observe(secondaryNav);
window.addEventListener("resize", () => {
  if (navigationAnimating) return;
  void movePrimaryIndicator(false, activeNavigationToken);
  moveSecondaryIndicator(false, activeNavigationToken);
});
getElement<HTMLElement>("settings-access-url").textContent = location.origin;
createPrimaryNavigation();
renderNavigation("initial");

function formatUptime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.status === "ok"
    && typeof data.service === "string"
    && typeof data.version === "string"
    && typeof data.uptimeMs === "number"
    && Number.isFinite(data.uptimeMs)
    && typeof data.startedAt === "string"
    && typeof data.checkedAt === "string";
}

async function refreshStatus(): Promise<void> {
  if (refreshButton.disabled) return;
  refreshButton.disabled = true;
  refreshButton.classList.add("is-busy");
  refreshLabel.textContent = "正在刷新";
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isHealthResponse(payload)) throw new Error("服务返回了不符合约定的数据");

    statusDot.className = "status-dot is-online";
    statusLabel.textContent = "后端已连接";
    mainStatus.textContent = "服务运行正常";
    statusDescription.textContent = "已连接到 Stardust Server";
    serverVersion.textContent = `v${payload.version}`;
    serverUptime.textContent = formatUptime(payload.uptimeMs);
    lastChecked.textContent = formatTime(payload.checkedAt);
  } catch (error) {
    statusDot.className = "status-dot is-offline";
    statusLabel.textContent = "后端未连接";
    mainStatus.textContent = "无法连接到服务";
    statusDescription.textContent = error instanceof Error ? error.message : "未知错误";
    serverVersion.textContent = "—";
    serverUptime.textContent = "—";
    lastChecked.textContent = "—";
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-busy");
    refreshLabel.textContent = "刷新状态";
  }
}

type ThemePreference = "system" | "light" | "dark";
const themeKey = "stardust-theme";

function applyTheme(preference: ThemePreference): void {
  if (preference === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = preference;
  }
  themeSelect.value = preference;
  setupThemeSelect.value = preference;
}

let storedTheme: string | null = null;
try {
  storedTheme = localStorage.getItem(themeKey);
} catch {
  // The interface still follows the system when storage is unavailable.
}
applyTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system");
function setThemePreference(preference: ThemePreference): void {
  applyTheme(preference);
  try {
    localStorage.setItem(themeKey, preference);
  } catch {
    // The selected theme remains active for this page session.
  }
}
themeSelect.addEventListener("change", () => setThemePreference(themeSelect.value as ThemePreference));
setupThemeSelect.addEventListener("change", () => setThemePreference(setupThemeSelect.value as ThemePreference));
refreshButton.addEventListener("click", () => void refreshStatus());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshStatus();
});
void refreshStatus();
setInterval(() => {
  if (!document.hidden) void refreshStatus();
}, 30_000);



type SetupConfig = {
  service: { description: string };
  server: { host: string; port: number };
  web: { title: string };
};
const setupDialog = getElement<HTMLDialogElement>("setup-dialog");
const setupForm = getElement<HTMLFormElement>("setup-form");
const setupDescription = getElement<HTMLTextAreaElement>("setup-description");
const setupTitle = getElement<HTMLInputElement>("setup-title");
const setupHost = getElement<HTMLInputElement>("setup-host");
const setupPort = getElement<HTMLInputElement>("setup-port");
const setupDefaults = getElement<HTMLInputElement>("setup-defaults");
const setupBack = getElement<HTMLButtonElement>("setup-back");
const setupNext = getElement<HTMLButtonElement>("setup-next");
const setupSubmit = getElement<HTMLButtonElement>("setup-submit");
const setupError = getElement<HTMLElement>("setup-error");
const setupStateError = getElement<HTMLElement>("setup-state-error");
const setupSteps = Array.from(document.querySelectorAll<HTMLElement>(".setup-step"));
let setupStep = 0;
let setupFinished = false;
let setupLoaded = false;
let setupBusy = false;
let previousServer = { host: "127.0.0.1", port: "8347" };

function setSetupError(message: string): void {
  setupError.textContent = message;
  setupError.hidden = !message;
}
function showSetupStep(step: number): void {
  setupStep = step;
  setSetupError("");
  setupSteps.forEach((section, index) => { section.hidden = index !== step; });
  setupBack.hidden = step === 0;
  setupNext.hidden = step === 3;
  setupSubmit.hidden = step !== 3;
  const heading = setupSteps[step]?.querySelector("h2");
  if (heading) {
    heading.id ||= `setup-step-heading-${step}`;
    setupDialog.setAttribute("aria-labelledby", heading.id);
    heading.tabIndex = -1;
    if (setupDialog.open) heading.focus();
  }
  if (step === 3) {
    getElement<HTMLElement>("summary-description").textContent = setupDescription.value || "—";
    getElement<HTMLElement>("summary-title").textContent = setupTitle.value;
    getElement<HTMLElement>("summary-host").textContent = setupHost.value;
    getElement<HTMLElement>("summary-port").textContent = setupPort.value;
  }
}
function validateSetupStep(): boolean {
  const fields = setupStep === 1 ? [setupTitle] : setupStep === 2 ? [setupHost, setupPort] : [];
  for (const field of fields) {
    field.setCustomValidity(field.type !== "number" && !field.value.trim() ? "此项不能为空。" : "");
    if (!field.reportValidity()) return false;
  }
  return true;
}
async function refreshSetupState(): Promise<void> {
  if (setupFinished) return;
  try {
    const response = await fetch("/api/v1/setup/state", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("状态不可用");
    const state = await response.json() as { initialized: boolean; config?: SetupConfig; webTitle?: string };
    if (setupFinished) return;
    if (typeof state.initialized !== "boolean") throw new Error("状态不可用");
    setupStateError.hidden = true;
    if (state.initialized) {
      setupFinished = true;
      if (typeof state.webTitle === "string") setWebTitle(state.webTitle);
      if (setupDialog.open) setupDialog.close();
      if (setupLoaded) goToOverview();
      showModel();
    } else if (!setupLoaded && state.config) {
      setupDescription.value = state.config.service.description;
      setupTitle.value = state.config.web.title;
      setupHost.value = state.config.server.host;
      setupPort.value = String(state.config.server.port);
      setupLoaded = true;
      showSetupStep(0);
      setupDialog.showModal();
    } else if (!setupLoaded) throw new Error("状态不可用");
  } catch {
    if (!setupLoaded) setupStateError.hidden = false;
  }
}
setupDialog.addEventListener("cancel", (event) => event.preventDefault());
setupDefaults.addEventListener("change", () => {
  if (setupDefaults.checked) {
    previousServer = { host: setupHost.value, port: setupPort.value };
    setupHost.value = "127.0.0.1";
    setupPort.value = "8347";
  } else {
    setupHost.value = previousServer.host;
    setupPort.value = previousServer.port;
  }
  setupHost.disabled = setupDefaults.checked;
  setupPort.disabled = setupDefaults.checked;
});
setupNext.addEventListener("click", () => { if (validateSetupStep()) showSetupStep(setupStep + 1); });
setupBack.addEventListener("click", () => showSetupStep(setupStep - 1));
getElement<HTMLButtonElement>("setup-retry").addEventListener("click", () => void refreshSetupState());
setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (setupBusy || setupStep !== 3) return;
  setupBusy = true;
  setupSubmit.disabled = true;
  setupBack.disabled = true;
  setSetupError("");
  void (async () => {
    try {
      const response = await fetch("/api/v1/setup/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: { description: setupDescription.value }, server: { host: setupHost.value, port: Number(setupPort.value) }, web: { title: setupTitle.value } }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 409) {
        await refreshSetupState();
        setupFinished = true;
        if (setupDialog.open) setupDialog.close();
        goToOverview();
        showModel();
        return;
      }
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(response.status === 400 ? data.message || "请检查填写的配置。" : "保存失败，请重试。");
      }
      setupFinished = true;
      setWebTitle(setupTitle.value);
      setupDialog.close();
      goToOverview();
      showModel();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      setupBusy = false;
      setupSubmit.disabled = false;
      setupBack.disabled = false;
    }
  })();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshSetupState(); });
void refreshSetupState();
setInterval(() => { if (!document.hidden) void refreshSetupState(); }, 3000);

type ModelView = { baseUrl: string; modelId: string; timeoutMs: number; stream: boolean; keyConfigured: boolean; keySource: "process" | "file" | "none"; fileKeyConfigured: boolean; processOverride: boolean };
const modelForm = getElement<HTMLFormElement>("model-form");
const modelUrl = getElement<HTMLInputElement>("model-url");
const modelId = getElement<HTMLInputElement>("model-id");
const modelTimeout = getElement<HTMLInputElement>("model-timeout");
const modelStream = getElement<HTMLInputElement>("model-stream");
const modelKey = getElement<HTMLInputElement>("model-key");
const modelClearKey = getElement<HTMLInputElement>("model-clear-key");
const modelKeyStatus = getElement<HTMLElement>("model-key-status");
const modelStatus = getElement<HTMLElement>("model-status");
const modelTestStatus = getElement<HTMLElement>("model-test-status");
const modelSave = getElement<HTMLButtonElement>("model-save");
const modelTest = getElement<HTMLButtonElement>("model-test");
const chatForm = getElement<HTMLFormElement>("chat-form");
const chatInput = getElement<HTMLTextAreaElement>("chat-input");
const chatSend = getElement<HTMLButtonElement>("chat-send");
const chatStatus = getElement<HTMLElement>("chat-status");
const chatMessages = getElement<HTMLElement>("chat-messages");
let modelLoaded = false;

async function modelRequest(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000),
    });
  } catch {
    throw new Error(noModelResponseMessage());
  }
  let data: unknown;
  try { data = await response.json(); }
  catch {
    if (!response.ok) throw new Error(formatModelError(undefined, response.status));
    throw new Error("Stardust 服务端返回了无法识别的响应。");
  }
  if (!response.ok) {
    throw new Error(formatModelError((data as { error?: unknown })?.error, response.status));
  }
  return data;
}
function renderModelConfig(config: ModelView): void {
  modelUrl.value = config.baseUrl;
  modelId.value = config.modelId;
  modelTimeout.value = String(config.timeoutMs);
  modelStream.checked = config.stream;
  modelKey.value = "";
  modelClearKey.checked = false;
  modelKey.disabled = false;
  if (config.processOverride) {
    modelKeyStatus.textContent = `当前使用进程环境变量，文件中的密钥修改不会生效，直至移除进程变量并重启。文件密钥${config.fileKeyConfigured ? "已配置" : "未配置"}。`;
  } else {
    modelKeyStatus.textContent = config.keyConfigured ? "API Key 已配置；留空可保留。" : "API Key 未配置；本地无鉴权服务可留空。";
  }
}
function showModel(): void {
  showExtensions();
  if (modelLoaded) return;
  modelLoaded = true;
  void modelRequest("/api/v1/model/config").then((value) => renderModelConfig(value as ModelView)).catch((error: unknown) => {
    modelLoaded = false;
    modelStatus.textContent = error instanceof Error ? error.message : "无法读取模型配置。";
  });
}
function setModelBusy(busy: boolean): void { modelSave.disabled = busy; modelTest.disabled = busy; }
modelClearKey.addEventListener("change", () => { modelKey.disabled = modelClearKey.checked; });
modelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (modelSave.disabled) return;
  setModelBusy(true);
  modelStatus.textContent = "正在保存…";
  const keyAction = modelClearKey.checked ? "clear" : modelKey.value ? "set" : "keep";
  const input: Record<string, unknown> = { baseUrl: modelUrl.value, modelId: modelId.value, timeoutMs: modelTimeout.valueAsNumber, stream: modelStream.checked, keyAction };
  if (keyAction === "set") input.apiKey = modelKey.value;
  void modelRequest("/api/v1/model/config", input).then((value) => {
    renderModelConfig(value as ModelView);
    modelStatus.textContent = "配置已保存。";
  }).catch((error: unknown) => { modelStatus.textContent = error instanceof Error ? error.message : "保存失败，请重试。"; })
    .finally(() => setModelBusy(false));
});
modelTest.addEventListener("click", () => {
  if (modelTest.disabled) return;
  setModelBusy(true);
  modelTestStatus.textContent = "正在测试已保存的配置…";
  void modelRequest("/api/v1/model/test", {}).then(() => { modelTestStatus.textContent = "连接测试成功。"; })
    .catch((error: unknown) => { modelTestStatus.textContent = error instanceof Error ? error.message : "连接测试失败。"; })
    .finally(() => setModelBusy(false));
});
function addMessage(role: string, message: string): void {
  const entry = document.createElement("div");
  entry.className = "chat-message";
  const label = document.createElement("strong");
  label.textContent = role;
  const content = document.createElement("p");
  content.textContent = message;
  entry.append(label, content);
  chatMessages.append(entry);
}
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (chatSend.disabled || !chatInput.value.trim()) return;
  const message = chatInput.value;
  addMessage("你", message);
  chatInput.value = "";
  chatSend.disabled = true;
  chatStatus.textContent = "正在等待回复…";
  void modelRequest("/api/v1/model/chat", { message }).then((value) => {
    addMessage("模型", (value as { reply: string }).reply);
    chatStatus.textContent = "";
  }).catch((error: unknown) => { chatStatus.textContent = error instanceof Error ? error.message : "发送失败，请重试。"; })
    .finally(() => { chatSend.disabled = false; });
});

type ExtensionView = { id: string; name: string; version: string; description: string; installed: boolean; enabled: boolean; state: string; error?: string; fields: { key: string; label: string; sensitive: boolean; required: boolean; configured: boolean; value?: string }[] };
const extensionList = getElement<HTMLElement>("extension-list");
const extensionFeedback = getElement<HTMLElement>("extension-feedback");
const extensionCards = new Map<string, { node: HTMLElement; status: HTMLElement; error: HTMLElement; fields: Map<string, { input: HTMLInputElement; clear?: HTMLInputElement; note?: HTMLElement }>; enable: HTMLButtonElement; disable: HTMLButtonElement }>();
let extensionsLoaded = false;
let extensionsBusy = false;
let extensionSignature = "";
async function extensionRequest(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000) }); }
  catch { throw new Error("无法连接 Stardust 服务端。"); }
  const data = await response.json() as { error?: string };
  if (!response.ok) {
    const messages: Record<string, string> = { NOT_CONFIGURED: "请先保存必填配置。", INVALID_INPUT: "配置无效，请检查输入。", SAVE_FAILED: "保存失败，请重试。", DELETE_CONFIG_FAILED: "删除配置失败，请重试。", NOT_INSTALLED: "扩展尚未安装。", ALREADY_INSTALLED: "扩展已安装。" };
    throw new Error(messages[data.error ?? ""] ?? `操作失败（HTTP ${response.status}）。`);
  }
  return data;
}
function extensionButton(label: string): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = "setup-secondary"; button.textContent = label; return button;
}
async function extensionAction(id: string, action: string, body: unknown): Promise<boolean> {
  if (extensionsBusy) return false;
  extensionsBusy = true; extensionFeedback.textContent = "正在处理…";
  try {
    await extensionRequest(`/api/v1/extensions/${encodeURIComponent(id)}/${action}`, body);
    extensionFeedback.textContent = "操作已完成。";
    if (action === "install" || action === "uninstall") extensionSignature = "";
    await refreshExtensions();
    return true;
  } catch (error) { extensionFeedback.textContent = error instanceof Error ? error.message : "操作失败。"; return false; }
  finally { extensionsBusy = false; }
}
function buildExtensionCards(items: ExtensionView[]): void {
  extensionList.replaceChildren(); extensionCards.clear();
  for (const item of items) {
    const node = document.createElement("article"); node.className = "extension-item";
    const title = document.createElement("h2"); title.textContent = `${item.name} · ${item.version}`;
    const description = document.createElement("p"); description.textContent = item.description;
    node.append(title, description);
    if (!item.installed) {
      const install = extensionButton(`添加${item.name}`);
      install.addEventListener("click", () => { void extensionAction(item.id, "install", {}); });
      node.append(install); extensionList.append(node); continue;
    }
    const status = document.createElement("p"); status.setAttribute("role", "status");
    const error = document.createElement("p"); error.setAttribute("role", "status");
    const form = document.createElement("form"); form.className = "extension-form";
    const fields = new Map<string, { input: HTMLInputElement; clear?: HTMLInputElement; note?: HTMLElement }>();
    for (const field of item.fields) {
      const label = document.createElement("label"); label.textContent = field.label;
      const input = document.createElement("input"); input.type = field.sensitive ? "password" : "text"; input.autocomplete = field.sensitive ? "new-password" : "off"; input.maxLength = 4096;
      if (!field.sensitive) input.value = field.value ?? ""; else input.placeholder = "留空以保留已保存的凭据";
      label.append(input); form.append(label);
      const entry: { input: HTMLInputElement; clear?: HTMLInputElement; note?: HTMLElement } = { input };
      if (field.sensitive) {
        const note = document.createElement("p"); form.append(note); entry.note = note;
        const clearLabel = document.createElement("label"); clearLabel.className = "model-check";
        const clear = document.createElement("input"); clear.type = "checkbox"; clear.addEventListener("change", () => { input.disabled = clear.checked; });
        clearLabel.append(clear, document.createTextNode(`清除${field.label}`)); form.append(clearLabel); entry.clear = clear;
      }
      fields.set(field.key, entry);
    }
    const actions = document.createElement("div"); actions.className = "extension-actions";
    const save = extensionButton("保存配置"); save.type = "submit";
    const enable = extensionButton("启用"); const disable = extensionButton("停用"); const uninstall = extensionButton("卸载");
    const deleteLabel = document.createElement("label"); deleteLabel.className = "model-check";
    const deleteConfig = document.createElement("input"); deleteConfig.type = "checkbox"; deleteLabel.append(deleteConfig, document.createTextNode("卸载时删除配置"));
    actions.append(save, enable, disable, uninstall); form.append(actions, deleteLabel);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); const values: Record<string, string | null> = {};
      for (const field of item.fields) { const entry = fields.get(field.key)!; if (entry.clear?.checked) values[field.key] = null; else if (!field.sensitive || entry.input.value) values[field.key] = entry.input.value; }
      void extensionAction(item.id, "config", values).then((ok) => { if (ok) for (const field of item.fields) if (field.sensitive) { const entry = fields.get(field.key)!; entry.input.value = ""; entry.input.disabled = false; if (entry.clear) entry.clear.checked = false; } });
    });
    enable.addEventListener("click", () => { void extensionAction(item.id, "enable", {}); });
    disable.addEventListener("click", () => { void extensionAction(item.id, "disable", {}); });
    uninstall.addEventListener("click", () => { void extensionAction(item.id, "uninstall", { deleteConfig: deleteConfig.checked }); });
    node.append(status, error, form); extensionList.append(node); extensionCards.set(item.id, { node, status, error, fields, enable, disable });
  }
}
async function refreshExtensions(): Promise<void> {
  try {
    const data = await extensionRequest("/api/v1/extensions") as { extensions: ExtensionView[] };
    if (!Array.isArray(data.extensions)) throw new Error("扩展状态不可用。");
    const signature = data.extensions.map((item) => `${item.id}:${item.installed}`).join("|");
    if (signature !== extensionSignature) { buildExtensionCards(data.extensions); extensionSignature = signature; }
    const labels: Record<string, string> = { connecting: "连接中", connected: "已连接", disconnected: "已断开", error: "错误" };
    for (const item of data.extensions) {
      const card = extensionCards.get(item.id); if (!card) continue;
      card.status.textContent = `${item.enabled ? "已启用" : "已停用"} · ${labels[item.state] ?? "已断开"}`;
      card.error.textContent = item.error ?? ""; card.enable.disabled = item.enabled; card.disable.disabled = !item.enabled;
      for (const field of item.fields) { const entry = card.fields.get(field.key); if (entry?.note) entry.note.textContent = field.configured ? `${field.label} 已配置。` : `${field.label} 未配置。`; }
    }
  } catch (error) { extensionFeedback.textContent = error instanceof Error ? error.message : "无法读取扩展状态。"; }
}
function showExtensions(): void {
  if (extensionsLoaded) return;
  extensionsLoaded = true; void refreshExtensions();
  setInterval(() => { if (!document.hidden) void refreshExtensions(); }, 5000);
}
