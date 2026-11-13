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
  { label: "模型", items: [{ label: "模型服务", id: "model-service", children: [{ label: "模型测试对话", path: "/model/chat" }, { label: "当前配置", path: "/model/service/config" }, { label: "连接测试", path: "/model/service/test" }] }, { label: "日志", path: "/model/logs" }] },
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
const extensionRoutes = new Map<string, { page: MenuPage; index: number; section: HTMLElement; owner: string }>();
let extensionsResolved = false;
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
  const extensionRoute = extensionRoutes.get(path);
  if (category === menu[2] && extensionRoute) return extensionRoute.index;
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
function createSecondaryNavigation(category: MenuCategory, path: string, animate: boolean, direction: NavigationDirection, token: number, startTime?: number): Promise<boolean[]> {
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
  const entering = animate ? animateElements(sideItems, "enter", direction, "x", token, navigationMotion.sidebarEnterPx, true, startTime) : Promise.resolve([]);
  moveSecondaryIndicator(animate, token, undefined, startTime);
  return entering;
}
function updateSecondarySelection(category: MenuCategory, path: string, animate: boolean, token: number, startTime?: number): void {
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
  moveSecondaryIndicator(animate, token, undefined, startTime);
}
function movePrimaryIndicator(animate: boolean, token: number, startTime?: number): Promise<boolean> {
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
    ...(startTime === undefined ? {} : { startTime }),
    properties: ["transform", "width"],
    onFinish: () => { primaryIndicator.style.transform = `translateX(${x}px)`; primaryIndicator.style.width = `${width}px`; },
  });
}
function moveSecondaryIndicator(animate: boolean, token: number, forcedTarget?: HTMLElement, startTime?: number): void {
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
    ...(startTime === undefined ? {} : { startTime }),
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
function animateElements(elements: HTMLElement[], mode: "enter" | "exit", direction: NavigationDirection, axis: "x" | "y", token: number, distance: number, initialize: boolean, startTime?: number): Promise<boolean[]> {
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
      ...(startTime === undefined ? {} : { startTime }),
      properties: ["translate", "opacity"],
      onFinish: mode === "enter" ? () => { element.style.removeProperty("translate"); element.style.removeProperty("opacity"); } : undefined,
    });
  }));
}
function nextNavigationStartTime(): number {
  const timelineTime = document.timeline.currentTime;
  return (typeof timelineTime === "number" ? timelineTime : performance.now()) + 16;
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
  const extensionPath = path.startsWith("/extensions/installed/");
  if (extensionPath && !extensionsResolved) return;
  let dynamic = extensionRoutes.get(path);
  let category = dynamic ? menu[2] : menu.find((item) => pages(item).some((page) => page.path === path));
  if (!category) {
    path = extensionPath ? "/extensions/installed" : "/overview/status";
    category = extensionPath ? menu[2]! : menu[0]!;
    dynamic = undefined;
    history.replaceState(null, "", `#${path}`);
  } else if (!location.hash) history.replaceState(null, "", `#${path}`);
  const page = dynamic?.page ?? pages(category).find((item) => item.path === path)!;
  const sidebarPath = dynamic ? "/extensions/installed" : path;
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
  const animationStartTime = animate ? nextNavigationStartTime() : undefined;
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
      section.inert = false;
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
    ? createSecondaryNavigation(category, sidebarPath, animate, direction, token, animationStartTime)
    : (updateSecondarySelection(category, sidebarPath, animate, token, animationStartTime), Promise.resolve([]));
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
  if (!targetWasVisible) targetSection.style.opacity = "0";
  const entering = animateElements(enterItems, "enter", direction, axis, token, navigationMotion.contentEnterPx, !targetWasVisible, animationStartTime);
  const exitingAnimation = animateElements(exiting, "exit", direction, axis, token, navigationMotion.contentExitPx, false, animationStartTime);
  const primary = movePrimaryIndicator(true, token, animationStartTime);
  // Both page surfaces use the same timeline start so the outgoing and incoming pages crossfade together.
  const fadePage = (section: HTMLElement, opacity: string): Promise<boolean> => motion.animate(section, [
    { opacity: getComputedStyle(section).opacity }, { opacity },
  ], { token, duration: navigationMotion.pageDurationMs, ...(animationStartTime === undefined ? {} : { startTime: animationStartTime }), properties: ["opacity"] });
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
  syncLogPage();
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
const adminForm = getElement<HTMLFormElement>("tool-admin-form");
const adminToken = getElement<HTMLInputElement>("tool-admin-token");
const adminStatus = getElement<HTMLElement>("tool-admin-status");
let adminAuthenticated = false;
let activeToolRun = "";
let toolRunSignature = "";
let toolRunPanel: HTMLElement | undefined;
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
  void refreshAdmin();
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
async function toolRequest(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new Error("无法连接 Stardust 服务端。"); }
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
async function refreshAdmin(): Promise<void> {
  try {
    const state = await toolRequest("/api/v1/admin/state") as { configured: boolean; authenticated: boolean };
    adminAuthenticated = state.authenticated; adminForm.hidden = !state.configured || state.authenticated;
    adminStatus.textContent = state.authenticated ? "管理员已登录，可以在对话中使用已启用的 Tool。" : state.configured ? "登录后可在模型测试对话中使用 Tool。" : "配置 STARDUST_ADMIN_TOKEN（至少 32 字符）并重启后可使用 Tool。";
    if (adminAuthenticated && !activeToolRun) {
      const saved = sessionStorage.getItem("stardust.toolRun");
      if (saved) { activeToolRun = saved; chatSend.disabled = true; toolRunPanel = document.createElement("div"); chatMessages.append(toolRunPanel); void pollToolRun(); }
    }
  } catch { adminStatus.textContent = "无法读取管理员认证状态。"; }
}
adminForm.addEventListener("submit", (event) => {
  event.preventDefault(); const token = adminToken.value; adminToken.value = "";
  void toolRequest("/api/v1/admin/login", { token }).then(() => refreshAdmin()).catch(() => { adminStatus.textContent = "管理员登录失败，请检查口令。"; });
});
type ToolRunView = { id: string; status: "working" | "waiting" | "executing" | "done" | "error"; reply?: string; error?: string; errorDetail?: { status?: number; code?: string; message?: string }; calls: { id: string; name: string; status: string; input?: Record<string, unknown>; approval?: { operation: string; targetDescription: string; channel?: string; content?: string; risk: string }; expiresAt?: string; result?: unknown }[] };
async function pollToolRun(): Promise<void> {
  const id = activeToolRun; if (!id) return;
  try {
    const run = await toolRequest(`/api/v1/tool-runs/${encodeURIComponent(id)}`) as ToolRunView;
    if (activeToolRun !== id) return;
    const signature = JSON.stringify(run);
    if (signature !== toolRunSignature && toolRunPanel) {
      toolRunSignature = signature; toolRunPanel.replaceChildren();
      for (const call of run.calls) {
        const card = document.createElement("details"); card.className = "tool-call"; card.open = call.status === "waiting";
        const labels: Record<string, string> = { validating: "正在校验", waiting: "等待管理员确认", executing: "执行中", sent: "请求成功", denied: "已拒绝", expired: "审批已过期", failed: "校验失败", unavailable: "不可用", rejected: "渠道拒绝", unknown_outcome: "发送结果未知" };
        const title = document.createElement("summary"); title.textContent = `Tool：${call.name} · ${labels[call.status] ?? call.status}`; card.append(title);
        if (call.approval) {
          const info = document.createElement("p"); info.textContent = `渠道：${call.approval.channel ?? "—"} · 目标：${call.approval.targetDescription} · 操作：${call.approval.operation}`;
          const content = document.createElement("pre"); content.textContent = call.approval.content ?? "";
          const warning = document.createElement("p"); warning.textContent = `${call.approval.risk} 审批有效期至 ${call.expiresAt ? new Date(call.expiresAt).toLocaleTimeString() : "—"}。`;
          const parameters = document.createElement("pre"); parameters.textContent = JSON.stringify(call.input, null, 2);
          card.append(info, content, parameters, warning);
        }
        if (call.result) { const result = document.createElement("pre"); result.textContent = JSON.stringify(call.result, null, 2); card.append(result); }
        if (call.status === "waiting") {
          const controls = document.createElement("div"); controls.className = "extension-actions";
          const approve = document.createElement("button"); approve.type = "button"; approve.className = "setup-primary"; approve.textContent = "批准一次";
          const deny = document.createElement("button"); deny.type = "button"; deny.className = "setup-secondary"; deny.textContent = "拒绝";
          const decide = (approved: boolean) => {
            approve.disabled = true; deny.disabled = true;
            void toolRequest(`/api/v1/tool-runs/${encodeURIComponent(id)}/decision`, { toolCallId: call.id, approved }).then(() => pollToolRun()).catch((error: unknown) => { chatStatus.textContent = error instanceof Error ? error.message : "审批失败。"; void pollToolRun(); });
          };
          approve.addEventListener("click", () => decide(true)); deny.addEventListener("click", () => decide(false)); controls.append(approve, deny); card.append(controls);
        }
        toolRunPanel.append(card);
      }
    }
    if (run.status === "done" || run.status === "error") {
      if (run.reply) addMessage("模型", run.reply);
      chatStatus.textContent = run.status === "error" ? `工具对话失败：${run.error ?? "未知错误"}${run.errorDetail?.status ? `（HTTP ${run.errorDetail.status}）` : ""}${run.errorDetail?.code ? ` · ${run.errorDetail.code}` : ""}${run.errorDetail?.message ? ` · ${run.errorDetail.message}` : ""}` : "";
      activeToolRun = ""; sessionStorage.removeItem("stardust.toolRun"); chatSend.disabled = false; return;
    }
    chatStatus.textContent = run.status === "waiting" ? "等待管理员确认。" : run.status === "executing" ? "正在执行 Tool…" : "模型处理中…";
    setTimeout(() => { if (activeToolRun === id) void pollToolRun(); }, 1200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取工具对话状态。";
    chatStatus.textContent = message;
    if (message === "RUN_NOT_FOUND" || message === "AUTH_REQUIRED") {
      activeToolRun = ""; sessionStorage.removeItem("stardust.toolRun"); chatSend.disabled = false;
      if (message === "AUTH_REQUIRED") { adminAuthenticated = false; void refreshAdmin(); }
    } else if (activeToolRun === id) setTimeout(() => { if (activeToolRun === id) void pollToolRun(); }, 3000);
  }
}
void refreshAdmin();
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (chatSend.disabled || !chatInput.value.trim()) return;
  const message = chatInput.value;
  addMessage("你", message);
  chatInput.value = "";
  chatSend.disabled = true;
  chatStatus.textContent = "正在等待回复…";
  if (adminAuthenticated) {
    void toolRequest("/api/v1/tool-runs", { message }).then((value) => {
      activeToolRun = (value as { id: string }).id; sessionStorage.setItem("stardust.toolRun", activeToolRun);
      toolRunSignature = ""; toolRunPanel = document.createElement("div"); chatMessages.append(toolRunPanel); void pollToolRun();
    }).catch((error: unknown) => { chatStatus.textContent = error instanceof Error ? error.message : "工具对话失败。"; chatSend.disabled = false; });
    return;
  }
  void modelRequest("/api/v1/model/chat", { message }).then((value) => {
    addMessage("模型", (value as { reply: string }).reply);
    chatStatus.textContent = "";
  }).catch((error: unknown) => { chatStatus.textContent = error instanceof Error ? error.message : "发送失败，请重试。"; })
    .finally(() => { chatSend.disabled = false; });
});

type ExtensionFieldView = { key: string; label: string; sensitive: boolean; required: boolean; configured: boolean; value?: string };
type ExtensionToolView = { name: string; description: string; parameters: Record<string, unknown>; enabled: boolean; available: boolean };
type ExtensionPageView = { pageId: string; title: string; description: string; pageKind: string };
type ExtensionView = { id: string; name: string; version: string; description: string; type: string; installed: boolean; enabled: boolean; state: string; error?: string; fields: ExtensionFieldView[]; managementPages: ExtensionPageView[]; skills: { name: string; description: string }[]; tools: ExtensionToolView[] };
const extensionList = getElement<HTMLElement>("extension-list");
const extensionFeedback = getElement<HTMLElement>("extension-feedback");
type ExtensionUI = { sections: HTMLElement[]; statuses: HTMLElement[]; errors: HTMLElement[]; fields: Map<string, { input: HTMLInputElement; clear?: HTMLInputElement; note?: HTMLElement }>; enable?: HTMLButtonElement; disable?: HTMLButtonElement; tools: Map<string, { status: HTMLElement; toggle: HTMLButtonElement }> };
const extensionPages = new Map<string, ExtensionUI>();
const extensionListStatuses = new Map<string, HTMLElement>();
let extensionsLoaded = false;
let extensionsBusy = false;
let extensionSignature = "";
async function extensionRequest(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, body === undefined ? { cache: "no-store" } : body instanceof FormData ? { method: "POST", body, signal: AbortSignal.timeout(280000) } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000) }); }
  catch { throw new Error("无法连接 Stardust 服务端。"); }
  const data = await response.json() as { error?: string };
  if (!response.ok) {
    const messages: Record<string, string> = { NOT_CONFIGURED: "请先保存必填配置。", INVALID_INPUT: "输入无效，请检查。", SAVE_FAILED: "保存失败，请重试。", DELETE_CONFIG_FAILED: "删除配置失败，请重试。", NOT_INSTALLED: "扩展尚未安装。", ALREADY_INSTALLED: "扩展已安装。", EXTENSION_NOT_CONNECTED: "请先启用并连接 QQ 扩展。", INVALID_TARGET: "目标无效或已过期，请刷新测试目标。", TEST_IN_PROGRESS: "另一项测试正在进行。", TEST_LIMIT_REACHED: "本次运行的测试记录已达上限。" };
    throw new Error(messages[data.error ?? ""] ?? `操作失败（HTTP ${response.status}）。`);
  }
  return data;
}
function extensionButton(label: string): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = "setup-secondary"; button.textContent = label; return button;
}
async function validateLocalPngSelection(input: HTMLInputElement): Promise<File[] | undefined> {
  input.setCustomValidity("");
  const files = Array.from(input.files ?? []);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  if (files.length !== 2) input.setCustomValidity("请恰好选择两张 PNG 图片。");
  else if (files.some((file) => file.type.toLowerCase() !== "image/png" || !file.name.toLowerCase().endsWith(".png") || file.size < 8 || file.size > 10 * 1024 * 1024)) input.setCustomValidity("两张图片都必须是 PNG，且单张不超过 10 MB。");
  if (input.validationMessage) { input.reportValidity(); return undefined; }
  const [first, second] = files;
  const [firstHeader, secondHeader, firstDigest, secondDigest] = await Promise.all([
    first!.slice(0, 8).arrayBuffer(), second!.slice(0, 8).arrayBuffer(),
    crypto.subtle.digest("SHA-256", await first!.arrayBuffer()), crypto.subtle.digest("SHA-256", await second!.arrayBuffer()),
  ]);
  if (!new Uint8Array(firstHeader).every((byte, index) => byte === signature[index]) || !new Uint8Array(secondHeader).every((byte, index) => byte === signature[index])) input.setCustomValidity("文件内容不是有效 PNG 文件。");
  else if (new Uint8Array(firstDigest).every((byte, index) => byte === new Uint8Array(secondDigest)[index])) input.setCustomValidity("请选择内容不同的两张 PNG 图片。");
  if (input.validationMessage) { input.reportValidity(); return undefined; }
  return files;
}
function buildQQCapabilityTests(id: string): HTMLElement {
  const section = document.createElement("section"); section.className = "capability-tests";
  const introduction = document.createElement("p"); introduction.textContent = "主动消息可能受平台限制；发送前需要确认，HTTP 成功不代表客户端已展示。";
  introduction.className = "capability-introduction";
  const interfaceNotes = document.createElement("details"); interfaceNotes.className = "capability-interface-notes";
  const interfaceSummary = document.createElement("summary"); interfaceSummary.textContent = "接口说明";
  const interfaceContent = document.createElement("div");
  const link = (label: string, href: string) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = label; return a; };
  const streamInfo = document.createElement("p"); streamInfo.textContent = "私聊使用 QQ C2C stream_messages；群聊使用实验性、未验证候选路径 POST /v2/groups/{group_openid}/stream_messages。候选路径的 400、403、404 仅代表本次请求结果，不代表平台整体能力。流式每帧间隔至少 300ms，首帧失败即结束，不重试。";
  const sourceLinks = document.createElement("p"); sourceLinks.className = "capability-sources";
  sourceLinks.append(link("QQ 发送接口文档", "https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md"), document.createTextNode(" · "), link("SDK 流式说明", "https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md"), document.createTextNode(" · "), link("富媒体文档", "https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/rich-media.md"));
  interfaceContent.append(streamInfo, sourceLinks); interfaceNotes.append(interfaceSummary, interfaceContent);
  const targetPanel = document.createElement("div"); targetPanel.className = "capability-target-panel";
  const targetHeading = document.createElement("div"); targetHeading.className = "capability-target-heading";
  const targetsHeading = document.createElement("h3"); targetsHeading.textContent = "最近接收的测试目标";
  const note = document.createElement("p"); note.textContent = "目标仅来自本次运行实际收到的消息；主动模式也使用已知目标。";
  targetHeading.append(targetsHeading, note);
  type Target = { id: string; scope: "private" | "group"; receivedAt: string; replyExpiresAt: string | null };
  type FrameResult = { index: number; inputState: number; state: string; httpStatus?: number; businessCode?: string; responseId?: string };
  type StageResult = { stage: "direct_send" | "upload" | "send"; state: string; httpStatus?: number; businessCode?: string; message?: string; messageIdReturned?: boolean };
  type ImageUploadResult = { image: 1 | 2; phase?: string; state: string; httpStatus?: number; businessCode?: string; message?: string; imageId?: string };
  type Result = { state: "success" | "partial_success" | "rejected" | "network_failure" | "unknown_outcome" | "unavailable"; interface: string; requestedAt: string; stage: string; httpStatus?: number; businessCode?: string; message?: string; serverAccepted: boolean; clientReceived: "unconfirmed"; mode?: "active" | "passive"; stream?: boolean; frameCount?: number; streamMsgId?: string; durationMs?: number; completion?: string; frames?: FrameResult[]; stages?: StageResult[]; imageUploads?: ImageUploadResult[]; messageIdReturned?: boolean; messageId?: string; requestMessageId?: string };
  let entries: Target[] = []; let busy = false;
  const targetControls = document.createElement("div"); targetControls.className = "capability-target-controls";
  const targetSelects = new Map<Target["scope"], HTMLSelectElement>();
  for (const scope of ["private", "group"] as const) {
    const selectLabel = document.createElement("label"); selectLabel.className = "capability-select"; selectLabel.append(document.createTextNode(scope === "private" ? "私聊目标" : "群聊目标"));
    const select = document.createElement("select"); select.setAttribute("aria-label", scope === "private" ? "私聊测试目标" : "群聊测试目标"); selectLabel.append(select); targetSelects.set(scope, select);
    select.addEventListener("change", updateTargets); targetControls.append(selectLabel);
  }
  const targetStatus = document.createElement("p"); targetStatus.className = "capability-target-status"; targetStatus.setAttribute("role", "status");
  const refresh = extensionButton("刷新测试目标");
  refresh.classList.add("capability-refresh");
  targetControls.append(refresh); targetPanel.append(targetHeading, targetControls, targetStatus);
  const list = document.createElement("div"); list.className = "capability-test-list";
  const tests: { kind: string; scope: Target["scope"]; mode: "active" | "passive"; media: boolean; button: HTMLButtonElement; result: HTMLElement; streamToggle?: HTMLInputElement; streamSupported: boolean; streamNotice?: HTMLElement; scopeSelect?: HTMLSelectElement; experiment?: "direct" | "empty-content" | "markdown" | "markdown-local"; observation?: HTMLSelectElement; imageUrl1?: HTMLInputElement; imageUrl2?: HTMLInputElement; imageFiles?: HTMLInputElement }[] = [];
  function selectedTarget(scope: Target["scope"]): Target | undefined { const select = targetSelects.get(scope); return entries.find((entry) => entry.scope === scope && entry.id === select?.value); }
  function updateTargets(): void {
    const selectedByScope = { private: selectedTarget("private"), group: selectedTarget("group") };
    const scopeStatus = (["private", "group"] as const).map((scope) => {
      const target = selectedByScope[scope];
      const label = scope === "private" ? "私聊" : "群聊";
      if (!target) return `${label}：先${scope === "private" ? "向机器人发送私聊消息" : "在群聊中 @机器人"}`;
      const remaining = target.replyExpiresAt ? Math.max(0, Math.ceil((Date.parse(target.replyExpiresAt) - Date.now()) / 1000)) : 0;
      return target.replyExpiresAt ? `${label}被动有效 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : `${label}被动期限未知`;
    });
    targetStatus.textContent = `${scopeStatus.join(" · ")}。`;
    for (const test of tests) {
      const selected = selectedByScope[test.scope];
      const streaming = test.streamToggle?.checked ?? false;
      const streamExpired = streaming && test.mode === "passive" && (!selected || Date.parse(selected.receivedAt) + 5 * 60_000 <= Date.now());
      const passiveExpired = test.mode === "passive" && (!selected?.replyExpiresAt || Date.parse(selected.replyExpiresAt) <= Date.now());
      test.button.disabled = busy || !selected || (test.mode === "passive" && passiveExpired) || streamExpired || (streaming && !test.streamSupported);
      if (test.streamNotice) test.streamNotice.hidden = !streaming;
    }
  }
  function refreshTargets(): void {
    refresh.disabled = true; targetStatus.textContent = "正在读取目标…";
    void extensionRequest(`/api/v1/extensions/${encodeURIComponent(id)}/capability-targets`).then((value) => {
      const current = { private: targetSelects.get("private")!.value, group: targetSelects.get("group")!.value };
      entries = (value as { targets: Target[] }).targets.slice().reverse();
      for (const scope of ["private", "group"] as const) {
        const select = targetSelects.get(scope)!; select.replaceChildren();
        const scoped = entries.filter((target) => target.scope === scope);
        for (const [index, target] of scoped.entries()) {
          const option = document.createElement("option"); option.value = target.id;
          option.textContent = `${new Date(target.receivedAt).toLocaleTimeString()} · 消息 ${index + 1}`; select.append(option);
        }
        select.disabled = scoped.length === 0;
        if (scoped.some((target) => target.id === current[scope])) select.value = current[scope];
      }
      updateTargets();
    }).catch((error: unknown) => { targetStatus.textContent = error instanceof Error ? error.message : "无法读取测试目标。"; }).finally(() => { refresh.disabled = false; });
  }
  refresh.addEventListener("click", refreshTargets);
  const scenarios = [
    { kind: "private-text", title: "私聊主动", scope: "private", mode: "active", media: false, streamSupported: true, warning: "主动消息可能受平台限制。", streamReason: "POST /v2/users/{openid}/stream_messages；主动模式不发送 msg_id 或 event_id。" },
    { kind: "private-text", title: "私聊被动", scope: "private", mode: "passive", media: false, streamSupported: true, warning: "被动消息使用所选真实私聊入站目标。", streamReason: "POST /v2/users/{openid}/stream_messages；被动模式使用真实 msg_id 和 event_id。" },
    { kind: "group-text", title: "群聊主动", scope: "group", mode: "active", media: false, streamSupported: true, warning: "主动消息可能受平台限制。", streamReason: "实验性、未验证候选接口：POST /v2/groups/{group_openid}/stream_messages；主动模式不发送 msg_id 或 event_id。" },
    { kind: "group-text", title: "群聊被动", scope: "group", mode: "passive", media: false, streamSupported: true, warning: "被动消息使用所选真实群聊入站目标。", streamReason: "实验性、未验证候选接口：POST /v2/groups/{group_openid}/stream_messages；被动模式使用真实 msg_id 和 event_id。" },
    { kind: "private-file", title: "私聊被动 TXT 文件", scope: "private", mode: "passive", media: true, streamSupported: false, warning: "普通文件在公开文档中标记为暂未开放。" },
    { kind: "group-file", title: "群聊被动 TXT 文件", scope: "group", mode: "passive", media: true, streamSupported: false, warning: "普通文件在公开文档中标记为暂未开放。" },
    { kind: "private-png", title: "私聊被动 PNG 图片", scope: "private", mode: "passive", media: true, streamSupported: false, warning: "实际能力取决于机器人权限和平台返回。" },
    { kind: "group-png", title: "群聊被动 PNG 图片", scope: "group", mode: "passive", media: true, streamSupported: false, warning: "实际能力取决于机器人权限和平台返回。" },
    { kind: "png-direct", title: "图片直接发送（srv_send_msg=true）", scope: "private", selectScope: true, mode: "active", media: true, experiment: "direct", streamSupported: false, warning: "会主动发送图片，可能消耗主动消息额度。" },
    { kind: "png-empty-content", title: "图片空 Content（content=\"\"）", scope: "private", selectScope: true, mode: "passive", media: true, experiment: "empty-content", streamSupported: false, warning: "仅对本次实验使用空 content；平台拒绝时不会回退为空格。" },
    { kind: "markdown-multi-image", title: "Markdown 多图", scope: "private", selectScope: true, mode: "passive", media: true, experiment: "markdown", streamSupported: false, warning: "使用真实入站消息被动回复；图片 URL 会随 Markdown 请求发送给 QQ 平台。" },
    { kind: "markdown-local-multi-image", title: "Markdown 本地多图", scope: "private", selectScope: true, mode: "passive", media: true, experiment: "markdown-local", streamSupported: false, warning: "选择两张 PNG 后上传至 QQ 官方图片素材库，并被动发送一条 Markdown 消息。单张上限 10 MB。" },
  ] as const;
  for (const scenario of scenarios) {
    const { kind, title, mode, media, streamSupported, warning } = scenario;
    let scope: Target["scope"] = scenario.scope;
    const experiment = "experiment" in scenario ? scenario.experiment : undefined;
    const streamReason = "streamReason" in scenario ? scenario.streamReason : "";
    const row = document.createElement("article"); row.className = "capability-test";
    const header = document.createElement("div"); header.className = "capability-test-header";
    const name = document.createElement("strong"); name.textContent = title;
    const modeLabel = document.createElement("span"); modeLabel.className = "capability-test-mode"; modeLabel.textContent = `${scope === "private" ? "私聊" : "群聊"} · ${mode === "passive" ? "被动" : "主动"}`;
    header.append(name, modeLabel);
    const details = document.createElement("p"); details.textContent = warning;
    const controls = document.createElement("div"); controls.className = "capability-test-controls";
    let scopeSelect: HTMLSelectElement | undefined;
    if ("selectScope" in scenario) {
      const scopeLabel = document.createElement("label"); scopeLabel.className = "capability-select"; scopeLabel.append(document.createTextNode("目标类型"));
      scopeSelect = document.createElement("select"); scopeSelect.setAttribute("aria-label", `${title}目标类型`);
      for (const [value, label] of [["private", "私聊"], ["group", "群聊"]] as const) { const option = document.createElement("option"); option.value = value; option.textContent = label; scopeSelect.append(option); }
      scopeSelect.value = scope; scopeLabel.append(scopeSelect); controls.append(scopeLabel);
    }
    let imageUrl1: HTMLInputElement | undefined; let imageUrl2: HTMLInputElement | undefined;
    let imageFiles: HTMLInputElement | undefined;
    if (experiment === "markdown") {
      for (const [number, labelText] of [[1, "图片 URL 1"], [2, "图片 URL 2"]] as const) {
        const label = document.createElement("label"); label.className = "capability-select"; label.append(document.createTextNode(labelText));
        const input = document.createElement("input"); input.type = "url"; input.required = true; input.maxLength = 2048; input.setAttribute("autocomplete", "url"); input.spellcheck = false; input.placeholder = "https://…"; input.setAttribute("aria-label", `${title} ${labelText}`);
        label.append(input); controls.append(label);
        if (number === 1) imageUrl1 = input; else imageUrl2 = input;
      }
    }
    if (experiment === "markdown-local") {
      const label = document.createElement("label"); label.className = "capability-select capability-file-input"; label.append(document.createTextNode("选择两张不同的 PNG（单张不超过 10 MB）"));
      imageFiles = document.createElement("input"); imageFiles.type = "file"; imageFiles.accept = "image/png,.png"; imageFiles.multiple = true; imageFiles.required = true; imageFiles.setAttribute("aria-label", "选择两张 PNG 图片");
      label.append(imageFiles); controls.append(label);
    }
    let streamToggle: HTMLInputElement | undefined; let streamNotice: HTMLElement | undefined;
    if (!media) {
      const streamLabel = document.createElement("label"); streamLabel.className = "capability-stream-toggle";
      streamLabel.setAttribute("aria-label", `${title}：启用流式`);
      streamToggle = document.createElement("input"); streamToggle.type = "checkbox";
      const toggleText = document.createElement("span"); toggleText.textContent = "启用流式";
      streamLabel.append(streamToggle, toggleText); controls.append(streamLabel);
      streamNotice = document.createElement("p"); streamNotice.className = "capability-stream-note"; streamNotice.textContent = streamReason; streamNotice.hidden = true;
      streamToggle.addEventListener("change", updateTargets);
    }
    const result = document.createElement("div"); result.className = "capability-test-result"; result.dataset.state = "untested"; result.setAttribute("role", "status"); result.setAttribute("aria-live", "polite");
    const resultTitle = document.createElement("strong"); resultTitle.className = "capability-result-title"; resultTitle.textContent = "未测试"; result.append(resultTitle);
    let observation: HTMLSelectElement | undefined;
    if (experiment) {
      const observationLabel = document.createElement("label"); observationLabel.className = "capability-select capability-observation"; observationLabel.append(document.createTextNode("客户端观察（手动记录）"));
      observation = document.createElement("select"); observation.setAttribute("aria-label", `${title}客户端观察结果`);
      const choices = experiment === "markdown-local"
        ? [["unchecked", "尚未检查"], ["two", "同一条消息成功显示两张图片"], ["split", "两张图片显示为不同消息"], ["one", "只显示一张图片"], ["markdown", "Markdown 可见但图片无法加载"], ["rejected", "消息被平台拒绝"]] as const
        : experiment === "markdown"
        ? [["unchecked", "尚未检查"], ["two", "同一条消息显示两张图片"], ["one", "只显示一张图片"], ["source", "显示 Markdown 源代码"], ["none", "图片均未显示"], ["missing", "未收到消息"]] as const
        : [["unchecked", "尚未检查"], ["normal", "图片正常显示，无额外空格"], ["space", "图片显示，但附带空格"], ["missing", "没有收到图片"]] as const;
      for (const [value, label] of choices) { const option = document.createElement("option"); option.value = value; option.textContent = label; observation.append(option); }
      observationLabel.append(observation);
    }
    const button = extensionButton("执行测试"); button.setAttribute("aria-label", `执行${title}`);
    const dialog = document.createElement("dialog"); dialog.className = "setup-dialog capability-confirm"; dialog.setAttribute("aria-label", `确认${title}`);
    const confirmation = document.createElement("p");
    const confirmActions = document.createElement("div"); confirmActions.className = "extension-actions";
    const cancel = extensionButton("取消"); const confirm = extensionButton("确认发送");
    confirmActions.append(cancel, confirm); dialog.append(confirmation, confirmActions);
    let pendingTarget: Target | undefined;
    let pendingLocalFiles: File[] | undefined;
    cancel.addEventListener("click", () => dialog.close());
    const test = { kind, scope, mode: mode as "active" | "passive", media, button, result, streamSupported, ...(streamToggle ? { streamToggle } : {}), ...(streamNotice ? { streamNotice } : {}), ...(scopeSelect ? { scopeSelect } : {}), ...(experiment ? { experiment } : {}), ...(observation ? { observation } : {}), ...(imageUrl1 ? { imageUrl1 } : {}), ...(imageUrl2 ? { imageUrl2 } : {}), ...(imageFiles ? { imageFiles } : {}) };
    tests.push(test);
    scopeSelect?.addEventListener("change", () => { scope = scopeSelect!.value as Target["scope"]; test.scope = scope; updateTargets(); });
    button.addEventListener("click", async () => {
      const target = selectedTarget(test.scope); if (!target || busy || button.disabled) return;
      if (test.experiment === "markdown" && (!test.imageUrl1?.reportValidity() || !test.imageUrl2?.reportValidity())) return;
      const selectedFiles = test.experiment === "markdown-local" ? await validateLocalPngSelection(test.imageFiles!) : undefined;
      if (test.experiment === "markdown-local" && !selectedFiles) return;
      const targetLabel = targetSelects.get(scope)?.selectedOptions[0]?.textContent ?? title;
      pendingTarget = target;
      pendingLocalFiles = selectedFiles;
      const streaming = streamToggle?.checked ?? false;
      const localFiles = selectedFiles ?? [];
      const parameters = experiment === "direct" ? "请求摘要：POST /files，file_type=1、srv_send_msg=true，不带 msg_id；只调用一次。" : experiment === "empty-content" ? "请求摘要：POST /files 获取 file_info，再 POST /messages，msg_type=7、content=空字符串，使用真实入站 msg_id。" : experiment === "markdown" ? `请求摘要：POST /messages，msg_type=2，使用真实入站 msg_id 和新序号。\n图片 1：${imageUrl1!.value}\n图片 2：${imageUrl2!.value}\n将把这两个图片 URL 提交给 QQ 平台。` : experiment === "markdown-local" ? `请求摘要：上传两张 PNG 到 QQ 图片素材库（prepare → 预签名 PUT → complete），随后 POST /messages，msg_type=2，使用真实入站 msg_id 和新序号。\n图片 1：${(localFiles[0]!.size / 1024 / 1024).toFixed(2)} MB\n图片 2：${(localFiles[1]!.size / 1024 / 1024).toFixed(2)} MB\n每张图片将传给 QQ 官方平台。` : "";
      confirmation.textContent = `确认向${targetLabel}执行“${title}”？${parameters}这会向 QQ 平台提交真实请求。${warning}`;
      dialog.showModal(); cancel.focus();
    });
    confirm.addEventListener("click", async () => {
      const target = pendingTarget;
      if (!target || busy) return;
      if (test.experiment === "markdown-local") {
        const selectedFiles = await validateLocalPngSelection(test.imageFiles!);
        if (!selectedFiles) return;
        pendingLocalFiles = selectedFiles;
      }
      pendingTarget = undefined; dialog.close();
      busy = true; updateTargets(); result.dataset.state = "testing"; resultTitle.textContent = "测试中…";
      const streaming = streamToggle?.checked ?? false;
      const requestScope = test.scope;
      const requestKind = experiment === "direct" ? `${requestScope}-png-direct` : experiment === "empty-content" ? `${requestScope}-png-empty-content` : experiment === "markdown" ? `${requestScope}-markdown-multi-image` : experiment === "markdown-local" ? `${requestScope}-markdown-local-multi-image` : kind;
      let requestBody: unknown = { targetId: target.id, kind: requestKind, mode, stream: streaming, requestId: crypto.randomUUID(), ...(experiment === "markdown" ? { imageUrl1: imageUrl1!.value, imageUrl2: imageUrl2!.value } : {}) };
      if (experiment === "markdown-local") {
        const form = new FormData(); form.set("targetId", target.id); form.set("kind", requestKind); form.set("mode", mode); form.set("requestId", crypto.randomUUID());
        form.set("image1", pendingLocalFiles![0]!); form.set("image2", pendingLocalFiles![1]!); requestBody = form; pendingLocalFiles = undefined;
      }
      void extensionRequest(`/api/v1/extensions/${encodeURIComponent(id)}/capability-test`, requestBody).then((data) => {
        const value = (data as { result: Result }).result;
        const states: Record<Result["state"], string> = { success: streaming ? "成功完成流式协议" : "请求成功", partial_success: "部分帧成功", rejected: value.httpStatus === 404 && streaming && requestScope === "group" ? "候选接口返回 404" : "平台拒绝", network_failure: "网络失败", unknown_outcome: "请求结果未知", unavailable: "未执行" };
        result.dataset.state = value.state;
        result.replaceChildren();
        const heading = document.createElement("strong"); heading.className = "capability-result-title"; heading.textContent = states[value.state]; result.append(heading);
        const summary = document.createElement("p"); summary.className = "capability-result-summary"; summary.textContent = `${requestScope === "private" ? "私聊" : "群聊"} · ${experiment === "direct" ? "主动" : mode === "passive" ? "被动" : "主动"} · ${experiment ? title : streaming ? `流式 · ${value.frameCount ?? 0} 帧` : "普通文本"} · ${value.durationMs === undefined ? "耗时未知" : `${value.durationMs} ms`} · 客户端展示未确认`;
        result.append(summary);
        const diagnostic = document.createElement("details"); diagnostic.className = "capability-result-details";
        const diagnosticSummary = document.createElement("summary"); diagnosticSummary.textContent = "请求诊断";
        const diagnosticList = document.createElement("dl");
          const localSendState = experiment === "markdown-local" ? (value.stage === "send" ? (value.state === "success" ? "成功响应" : value.state === "rejected" ? "平台拒绝" : value.state === "unknown_outcome" ? "请求结果未知" : "发送失败") : "未发送") : undefined;
          const fields: [string, string][] = [["接口", value.interface], ...(localSendState ? [["Markdown 发送状态", localSendState] as [string, string]] : []), ["请求时间", new Date(value.requestedAt).toLocaleString()], ["请求耗时", value.durationMs === undefined ? "未知" : `${value.durationMs} ms`], ["阶段", value.stage], ["HTTP", value.httpStatus === undefined ? (value.serverAccepted ? "状态缺失" : "无响应") : String(value.httpStatus)], ["QQ 业务码", value.businessCode ?? "无"], ...(value.requestMessageId ? [["入站消息 ID", value.requestMessageId] as [string, string]] : []), ...(value.messageId ? [["返回消息 ID", value.messageId] as [string, string]] : []), ["响应含消息 ID", value.messageIdReturned === undefined ? "不适用" : value.messageIdReturned ? "是" : "否"], ["客户端收到", value.clientReceived === "unconfirmed" ? "未确认" : "未知"], ["流式 ID", value.streamMsgId ?? "无"], ["完成状态", value.completion ?? (value.serverAccepted ? "请求已接受" : "未开始")], ["错误信息", value.message ?? "无"]];
        for (const [label, text] of fields) { const line = document.createElement("div"); const term = document.createElement("dt"); term.textContent = label; const valueNode = document.createElement("dd"); valueNode.textContent = text; line.append(term, valueNode); diagnosticList.append(line); }
        diagnostic.append(diagnosticSummary, diagnosticList);
        if (value.stages?.length) {
          const stageList = document.createElement("ol"); stageList.className = "capability-frame-list";
          for (const item of value.stages) { const line = document.createElement("li"); line.textContent = `${item.stage === "direct_send" ? "富媒体直接发送" : item.stage === "upload" ? "上传" : "消息发送"} · ${item.state === "success" ? "成功响应" : item.state === "rejected" ? "平台拒绝" : item.state === "unknown_outcome" ? "结果未知" : "网络失败"} · HTTP ${item.httpStatus ?? "无响应"}${item.businessCode ? ` · QQ 业务码 ${item.businessCode}` : ""}${item.message ? ` · ${item.message}` : ""}`; stageList.append(line); }
          const stageHeading = document.createElement("p"); stageHeading.className = "capability-frame-heading"; stageHeading.textContent = "请求阶段"; diagnostic.append(stageHeading, stageList);
        }
        if (value.imageUploads?.length) {
          const uploadList = document.createElement("ol"); uploadList.className = "capability-frame-list";
          for (const item of value.imageUploads) {
            const state = item.state === "success" ? "成功" : item.state === "not_started" ? "未开始" : item.state === "unknown_outcome" ? "结果未知" : item.state === "network_failure" ? "网络失败" : "平台拒绝";
            const phase = item.phase === "prepare" ? "申请素材上传" : item.phase === "put" ? "预签名上传" : item.phase === "complete" ? "完成素材登记" : "";
            const line = document.createElement("li"); line.textContent = `图片 ${item.image} · ${phase || "素材上传"} · ${state}${item.httpStatus === undefined ? "" : ` · HTTP ${item.httpStatus}`}${item.businessCode ? ` · QQ 业务码 ${item.businessCode}` : ""}${item.imageId ? ` · image_id ${item.imageId}` : ""}${item.message ? ` · ${item.message}` : ""}`; uploadList.append(line);
          }
          const uploadHeading = document.createElement("p"); uploadHeading.className = "capability-frame-heading"; uploadHeading.textContent = "图片素材上传"; diagnostic.append(uploadHeading, uploadList);
        }
        if (value.frames?.length) {
          const frames = document.createElement("ol"); frames.className = "capability-frame-list";
          for (const frame of value.frames) { const item = document.createElement("li"); item.textContent = `帧 ${frame.index + 1} · ${frame.inputState === 10 ? "完成" : "更新"} · ${frame.state === "success" ? "请求成功" : frame.state === "rejected" ? "平台拒绝" : frame.state === "unknown_outcome" ? "结果未知" : "网络失败"} · HTTP ${frame.httpStatus ?? "未提供"}${frame.businessCode ? ` · QQ 业务码 ${frame.businessCode}` : ""}${frame.responseId ? ` · 响应 ID ${frame.responseId}` : ""}`; frames.append(item); }
          const frameHeading = document.createElement("p"); frameHeading.className = "capability-frame-heading"; frameHeading.textContent = `流式帧（${value.frames.length}）`;
          diagnostic.append(frameHeading, frames);
        }
        result.append(diagnostic);
        if (value.httpStatus === 404 && streaming && requestScope === "group") {
          const note = document.createElement("p"); note.className = "capability-result-summary"; note.textContent = "该候选路径返回 404；这不能证明 QQ 平台不存在其他群聊流式能力。"; result.append(note);
        }
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "请求失败";
        result.dataset.state = "network_failure";
        resultTitle.textContent = message === "无法连接 Stardust 服务端。" ? "请求结果未知" : "不可执行";
        const detail = document.createElement("p"); detail.className = "capability-result-summary"; detail.textContent = message === "无法连接 Stardust 服务端。" ? `${message}发送状态未知，请先检查 QQ 客户端。` : message; result.replaceChildren(resultTitle, detail);
      }).finally(() => { busy = false; updateTargets(); });
    });
    controls.append(button); row.append(header, details, ...(streamNotice ? [streamNotice] : []), controls, result, ...(observation ? [observation.parentElement!] : []), dialog); list.append(row);
  }
  section.append(introduction, interfaceNotes, targetPanel, list);
  updateTargets(); queueMicrotask(refreshTargets);
  const timer = setInterval(() => { if (!section.isConnected) clearInterval(timer); else updateTargets(); }, 1000);
  return section;
}
async function extensionAction(id: string, action: string, body: unknown, feedback: HTMLElement = extensionFeedback): Promise<boolean> {
  if (extensionsBusy) return false;
  extensionsBusy = true; feedback.textContent = "正在处理…";
  try {
    await extensionRequest(`/api/v1/extensions/${encodeURIComponent(id)}/${action}`, body);
    feedback.textContent = "操作已完成。";
    await refreshExtensions();
    return true;
  } catch (error) { feedback.textContent = error instanceof Error ? error.message : "操作失败。"; return false; }
  finally { extensionsBusy = false; }
}

function extensionStatus(item: ExtensionView): string {
  const labels: Record<string, string> = { connecting: "连接中", connected: "已连接", disconnected: "已断开", error: "错误" };
  return `${item.enabled ? "已启用" : "已停用"} · ${labels[item.state] ?? "已断开"}`;
}
function extensionPath(id: string): string { return `/extensions/installed/${id}`; }
function extensionIcon(kind: string): SVGSVGElement {
  const paths: Record<string, string[]> = {
    extension: ["M8 3h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v5h-5a2 2 0 1 0-4 0H4v-5a2 2 0 1 1 0-4V3h4"],
    config: ["M4 7h16M4 17h16", "M9 4v6M15 14v6"],
    capabilities: ["M3 12h4l3-7 4 14 3-7h4"],
    tools: ["M14 6a5 5 0 0 0-6 6l-5 5a2 2 0 0 0 3 3l5-5a5 5 0 0 0 6-6l-3 3-3-3z"],
    skills: ["M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4z", "m9 12 2 2 4-4"],
  };
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.classList.add("extension-icon");
  for (const d of paths[kind] ?? paths.extension!) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d); icon.append(path);
  }
  return icon;
}
function extensionLink(label: string, path: string, className = "extension-link"): HTMLAnchorElement {
  return createPageLink({ label, path }, location.hash.slice(1), className, 1);
}
function extensionBreadcrumb(item: ExtensionView, page?: ExtensionPageView): HTMLElement {
  const nav = document.createElement("nav"); nav.className = "extension-breadcrumb"; nav.setAttribute("aria-label", "扩展页面路径");
  nav.append(extensionLink("已安装扩展", "/extensions/installed"));
  if (page) nav.append(document.createTextNode(" / "), extensionLink(item.name, extensionPath(item.id)), document.createTextNode(` / ${page.title}`));
  else nav.append(document.createTextNode(` / ${item.name}`));
  return nav;
}
function configPage(item: ExtensionView, ui: ExtensionUI): HTMLElement {
  const container = document.createElement("div");
  const status = document.createElement("p"); status.setAttribute("role", "status"); ui.statuses.push(status);
  const error = document.createElement("p"); error.setAttribute("role", "status"); ui.errors.push(error);
  const feedback = document.createElement("p"); feedback.className = "model-feedback"; feedback.setAttribute("role", "status");
  const form = document.createElement("form"); form.className = "extension-form";
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
    ui.fields.set(field.key, entry);
  }
  const actions = document.createElement("div"); actions.className = "extension-actions";
  const save = extensionButton("保存配置"); save.type = "submit";
  const enable = extensionButton("启用"); const disable = extensionButton("停用"); const uninstall = extensionButton("卸载");
  ui.enable = enable; ui.disable = disable;
  const deleteLabel = document.createElement("label"); deleteLabel.className = "model-check";
  const deleteConfig = document.createElement("input"); deleteConfig.type = "checkbox"; deleteLabel.append(deleteConfig, document.createTextNode("卸载时删除配置"));
  actions.append(save, enable, disable, uninstall); form.append(actions, deleteLabel);
  form.addEventListener("submit", (event) => {
    event.preventDefault(); const values: Record<string, string | null> = {};
    for (const field of item.fields) { const entry = ui.fields.get(field.key)!; if (entry.clear?.checked) values[field.key] = null; else if (!field.sensitive || entry.input.value) values[field.key] = entry.input.value; }
    void extensionAction(item.id, "config", values, feedback).then((ok) => { if (ok) for (const field of item.fields) if (field.sensitive) { const entry = ui.fields.get(field.key)!; entry.input.value = ""; entry.input.disabled = false; if (entry.clear) entry.clear.checked = false; } });
  });
  enable.addEventListener("click", () => { void extensionAction(item.id, "enable", {}, feedback); });
  disable.addEventListener("click", () => { void extensionAction(item.id, "disable", {}, feedback); });
  uninstall.addEventListener("click", () => { void extensionAction(item.id, "uninstall", { deleteConfig: deleteConfig.checked }, feedback); });
  container.append(status, error, form, feedback); return container;
}
function toolsPage(item: ExtensionView, ui: ExtensionUI): HTMLElement {
  const container = document.createElement("div");
  const feedback = document.createElement("p"); feedback.className = "model-feedback"; feedback.setAttribute("role", "status");
  if (!item.tools.length) { const empty = document.createElement("p"); empty.textContent = "此扩展尚未提供 Tool"; container.append(empty); }
  for (const tool of item.tools) {
    const row = document.createElement("article"); row.className = "extension-item";
    const heading = document.createElement("h2"); heading.textContent = tool.name;
    const description = document.createElement("p"); description.textContent = tool.description;
    const status = document.createElement("p"); status.setAttribute("role", "status");
    const toggle = extensionButton("启用"); toggle.dataset.enabled = String(tool.enabled);
    toggle.addEventListener("click", () => { void extensionAction(item.id, "tool", { name: tool.name, enabled: toggle.dataset.enabled !== "true" }, feedback); });
    const schema = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "参数 Schema";
    const pre = document.createElement("pre"); pre.className = "extension-schema"; pre.textContent = JSON.stringify(tool.parameters, null, 2);
    schema.append(summary, pre); row.append(heading, description, status, toggle, schema); container.append(row);
    ui.tools.set(tool.name, { status, toggle });
  }
  container.append(feedback); return container;
}
function skillsPage(item: ExtensionView): HTMLElement {
  const container = document.createElement("div");
  if (!item.skills.length) { const empty = document.createElement("p"); empty.textContent = "此扩展尚未提供 Skill"; container.append(empty); }
  else for (const skill of item.skills) { const row = document.createElement("p"); row.textContent = `${skill.name} · ${skill.description}`; container.append(row); }
  return container;
}
const extensionPageFactories: Record<string, (item: ExtensionView, ui: ExtensionUI) => HTMLElement> = {
  config: configPage,
  "qq-capabilities": (item) => buildQQCapabilityTests(item.id),
  tools: toolsPage,
  skills: (item) => skillsPage(item),
};
function registerExtensionPages(item: ExtensionView): void {
  const ui: ExtensionUI = { sections: [], statuses: [], errors: [], fields: new Map(), tools: new Map() };
  extensionPages.set(item.id, ui);
  const register = (path: string, title: string, index: number, content: HTMLElement): void => {
    const section = document.createElement("section"); section.className = "nav-page content-section extension-detail"; section.dataset.page = path; section.hidden = true; section.inert = true;
    content.dataset.transitionOrder = "2"; section.append(content); pageStage.append(section); navPages.push(section); ui.sections.push(section);
    extensionRoutes.set(path, { page: { label: title, path }, index, section, owner: item.id });
  };
  const root = document.createElement("div"); root.append(extensionBreadcrumb(item));
  const description = document.createElement("p"); description.textContent = item.description;
  const status = document.createElement("p"); status.setAttribute("role", "status"); ui.statuses.push(status);
  const error = document.createElement("p"); error.setAttribute("role", "status"); ui.errors.push(error);
  root.append(description, status, error);
  const links = document.createElement("div"); links.className = "extension-page-links";
  for (const page of item.managementPages) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.pageId) || !Object.hasOwn(extensionPageFactories, page.pageKind)) continue;
    const path = `${extensionPath(item.id)}/${page.pageId}`;
    const link = extensionLink("", path, "extension-page-link");
    const icon = document.createElement("span"); icon.className = "extension-icon-box"; icon.append(extensionIcon(page.pageKind));
    const copy = document.createElement("span"); copy.className = "extension-page-copy";
    const title = document.createElement("strong"); title.textContent = page.title;
    const description = document.createElement("span"); description.textContent = page.description;
    copy.append(title, description); link.append(icon, copy); links.append(link);
  }
  root.append(links); register(extensionPath(item.id), item.name, 1, root);
  for (const [index, page] of item.managementPages.entries()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.pageId) || !Object.hasOwn(extensionPageFactories, page.pageKind)) continue;
    const content = document.createElement("div"); content.append(extensionBreadcrumb(item, page), extensionPageFactories[page.pageKind]!(item, ui));
    register(`${extensionPath(item.id)}/${page.pageId}`, page.title, index + 2, content);
  }
}
function removeExtensionPages(id: string): void {
  const ui = extensionPages.get(id); if (!ui) return;
  for (const [path, route] of extensionRoutes) if (route.owner === id) extensionRoutes.delete(path);
  extensionPages.delete(id);
  if (currentPath === extensionPath(id) || currentPath.startsWith(`${extensionPath(id)}/`)) { history.replaceState(null, "", "#/extensions/installed"); renderNavigation("programmatic"); }
  window.setTimeout(() => {
    for (const section of ui.sections) { const index = navPages.indexOf(section); if (index >= 0) navPages.splice(index, 1); section.remove(); }
  }, navigationMotion.pageDurationMs + 80);
}
function buildExtensionList(items: ExtensionView[]): void {
  extensionList.replaceChildren(); extensionListStatuses.clear();
  const installed = items.filter((item) => item.installed);
  if (!installed.length) { const empty = document.createElement("p"); empty.textContent = "尚未安装扩展。"; extensionList.append(empty); }
  for (const item of installed) {
    const card = extensionLink("", extensionPath(item.id), "extension-card");
    const icon = document.createElement("span"); icon.className = "extension-icon-box extension-card-icon"; icon.append(extensionIcon("extension"));
    const copy = document.createElement("span"); copy.className = "extension-card-copy";
    const title = document.createElement("h2"); title.textContent = `${item.name} · ${item.version}`;
    const description = document.createElement("p"); description.textContent = item.description;
    const status = document.createElement("span"); status.className = "extension-card-status"; status.setAttribute("role", "status"); extensionListStatuses.set(item.id, status);
    copy.append(title, description, status); card.append(icon, copy); extensionList.append(card);
  }
  const available = items.filter((item) => !item.installed);
  if (available.length) {
    const heading = document.createElement("h2"); heading.className = "extension-available"; heading.textContent = "可添加的扩展"; extensionList.append(heading);
    for (const item of available) { const install = extensionButton(`添加${item.name}`); install.addEventListener("click", () => { void extensionAction(item.id, "install", {}); }); extensionList.append(install); }
  }
}
async function refreshExtensions(): Promise<void> {
  try {
    const data = await extensionRequest("/api/v1/extensions") as { extensions: ExtensionView[] };
    if (!Array.isArray(data.extensions)) throw new Error("扩展状态不可用。");
    const signature = data.extensions.map((item) => `${item.id}:${item.installed}`).join("|");
    if (signature !== extensionSignature) { buildExtensionList(data.extensions); extensionSignature = signature; }
    for (const id of extensionPages.keys()) if (!data.extensions.some((item) => item.id === id && item.installed)) removeExtensionPages(id);
    for (const item of data.extensions) if (item.installed && !extensionPages.has(item.id)) registerExtensionPages(item);
    extensionsResolved = true;
    if (!currentPath || (location.hash.slice(1).startsWith("/extensions/installed/") && currentPath !== location.hash.slice(1))) renderNavigation(currentPath ? "history" : "initial");
    for (const item of data.extensions) {
      const status = extensionListStatuses.get(item.id); if (status) status.textContent = extensionStatus(item);
      const ui = extensionPages.get(item.id); if (!ui) continue;
      for (const node of ui.statuses) node.textContent = extensionStatus(item);
      for (const node of ui.errors) node.textContent = item.error ?? "";
      if (ui.enable) ui.enable.disabled = item.enabled; if (ui.disable) ui.disable.disabled = !item.enabled;
      for (const field of item.fields) { const entry = ui.fields.get(field.key); if (entry?.note) entry.note.textContent = field.configured ? `${field.label} 已配置。` : `${field.label} 未配置。`; }
      for (const tool of item.tools) { const entry = ui.tools.get(tool.name); if (!entry) continue; entry.status.textContent = `${tool.enabled ? "已启用" : "已停用"} · ${tool.available ? "可用" : "不可用"}`; entry.toggle.textContent = tool.enabled ? "停用" : "启用"; entry.toggle.dataset.enabled = String(tool.enabled); }
    }
  } catch (error) { extensionFeedback.textContent = error instanceof Error ? error.message : "无法读取扩展状态。"; }
}
function showExtensions(): void {
  if (extensionsLoaded) return;
  extensionsLoaded = true; void refreshExtensions();
  setInterval(() => { if (!document.hidden) void refreshExtensions(); }, 5000);
}


type BrowserLog = { id: number; timestamp: string; level: string; source: string; message: string; details?: Record<string, unknown> };
type LogHistory = { entries: BrowserLog[]; oldest: number; latest: number; gap: boolean; instanceId: string };
const logList = getElement<HTMLElement>("log-list");
const logConnection = getElement<HTMLElement>("log-connection");
const logPause = getElement<HTMLButtonElement>("log-pause");
const logCopy = getElement<HTMLButtonElement>("log-copy");
const logClear = getElement<HTMLButtonElement>("log-clear");
const maxVisibleLogs = 500;
let displayedLogs: BrowserLog[] = [];
let pendingLogs: BrowserLog[] = [];
let logCursor = 0;
let logInstance = "";
let logStream: EventSource | undefined;
let logGeneration = 0;
let logActive = false;
let logPaused = false;
let logFollow = true;
let logGap = false;
let logFrame = 0;
function logLine(entry: BrowserLog): string {
  return `${new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })} ${entry.level} [${entry.source}] ${entry.message}`;
}
function hasVisibleLogDetails(entry: BrowserLog): boolean {
  return Boolean(entry.details && Object.keys(entry.details).length && (entry.level === "ERROR" || (entry.source === "qq-bot" && typeof entry.details.rawEventType === "string")));
}
function renderQueuedLogs(): void {
  logFrame = 0;
  if (logPaused || !pendingLogs.length) return;
  const batch = pendingLogs; pendingLogs = [];
  const fragment = document.createDocumentFragment();
  for (const entry of batch) {
    const row = document.createElement("div"); row.className = "log-entry"; row.dataset.level = entry.level;
    const line = document.createElement("div"); line.textContent = logLine(entry); row.append(line);
    if (hasVisibleLogDetails(entry)) {
      const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "诊断详情";
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(entry.details, null, 2); details.append(summary, pre); row.append(details);
    }
    fragment.append(row); displayedLogs.push(entry);
  }
  logList.append(fragment);
  while (displayedLogs.length > maxVisibleLogs) { displayedLogs.shift(); logList.firstElementChild?.remove(); }
  if (logFollow) logList.scrollTop = logList.scrollHeight;
}
function acceptLog(entry: BrowserLog): void {
  if (!Number.isSafeInteger(entry.id) || entry.id <= logCursor) return;
  logCursor = entry.id;
  pendingLogs.push(entry);
  if (pendingLogs.length > maxVisibleLogs) { pendingLogs.shift(); logGap = true; logConnection.textContent = "显示缓冲已满，部分较早日志已被丢弃"; }
  if (!logPaused && !logFrame) logFrame = requestAnimationFrame(renderQueuedLogs);
}
async function startLogStream(): Promise<void> {
  const generation = ++logGeneration;
  logConnection.textContent = "正在连接日志服务…";
  try {
    const response = await fetch(`/api/v1/logs?after=${logCursor}&limit=${logCursor ? 1000 : 200}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const history = await response.json() as LogHistory;
    if (!logActive || generation !== logGeneration) return;
    if (!Array.isArray(history.entries) || typeof history.instanceId !== "string") throw new Error();
    if ((logInstance && logInstance !== history.instanceId) || logCursor > history.latest) {
      logCursor = 0; displayedLogs = []; pendingLogs = []; logList.replaceChildren();
      logInstance = history.instanceId; void startLogStream(); return;
    }
    logInstance = history.instanceId;
    if (history.gap) logGap = true;
    for (const entry of history.entries) acceptLog(entry);
    logCursor = Math.max(logCursor, history.latest);
    const stream = new EventSource(`/api/v1/logs/stream?after=${logCursor}&instance=${encodeURIComponent(logInstance)}`);
    logStream = stream;
    stream.onopen = () => { if (generation === logGeneration) logConnection.textContent = logGap ? "日志服务已连接；部分较早日志已被淘汰" : "日志服务已连接"; };
    stream.onmessage = (event) => { try { acceptLog(JSON.parse(event.data) as BrowserLog); } catch { logConnection.textContent = "收到无法识别的日志"; } };
    stream.addEventListener("gap", () => { logGap = true; logConnection.textContent = "部分较早日志已被淘汰"; });
    stream.addEventListener("reset", () => {
      if (generation !== logGeneration) return;
      stream.close(); logStream = undefined; logCursor = 0; logInstance = ""; displayedLogs = []; pendingLogs = []; logList.replaceChildren();
      void startLogStream();
    });
    stream.onerror = () => { if (generation === logGeneration) logConnection.textContent = "日志连接中断，正在重连…"; };
  } catch {
    if (logActive && generation === logGeneration) {
      logConnection.textContent = "无法连接日志服务，正在重试…";
      window.setTimeout(() => { if (logActive && generation === logGeneration) void startLogStream(); }, 3000);
    }
  }
}
function syncLogPage(): void {
  const active = location.hash.slice(1) === "/model/logs";
  if (active === logActive) return;
  logActive = active;
  if (active) void startLogStream();
  else { logGeneration++; logStream?.close(); logStream = undefined; logConnection.textContent = "日志服务未连接"; }
}
logList.addEventListener("scroll", () => { logFollow = logList.scrollHeight - logList.clientHeight - logList.scrollTop < 20; });
logPause.addEventListener("click", () => { logPaused = !logPaused; logPause.textContent = logPaused ? "恢复更新" : "暂停更新"; if (!logPaused && !logFrame) logFrame = requestAnimationFrame(renderQueuedLogs); });
logClear.addEventListener("click", () => { displayedLogs = []; pendingLogs = []; logList.replaceChildren(); logFollow = true; });
logCopy.addEventListener("click", () => {
  const text = displayedLogs.map((entry) => `${logLine(entry)}${hasVisibleLogDetails(entry) ? `\n${JSON.stringify(entry.details, null, 2)}` : ""}`).join("\n");
  if (!navigator.clipboard) { logConnection.textContent = "无法复制日志"; return; }
  void navigator.clipboard.writeText(text).then(() => { logConnection.textContent = "日志已复制"; }).catch(() => { logConnection.textContent = "无法复制日志"; });
});
window.addEventListener("hashchange", syncLogPage);
window.addEventListener("pagehide", () => { logGeneration++; logStream?.close(); logStream = undefined; logActive = false; });
window.addEventListener("pageshow", syncLogPage);
syncLogPage();
