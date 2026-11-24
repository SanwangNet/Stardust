type NavigationCategory = { items: readonly ({ path: string } | { children: readonly { path: string }[] })[] };

/** Dynamic extension routes belong to the category containing the extension root. */
export function categoryForNavigation<T extends NavigationCategory>(categories: readonly T[], path: string, dynamic: boolean): T | undefined {
  const target = dynamic ? "/extensions/installed" : path;
  return categories.find(category => category.items.some(item => "children" in item ? item.children.some(child => child.path === target) : item.path === target));
}

/** A clicked child card keeps its expansion even when it changes menu category. */
export function usesRootPageTransition(input: {
  previousPath: string;
  categoryChanged: boolean;
  cardEntersChild: boolean;
}): boolean {
  return Boolean(input.previousPath && input.categoryChanged && !input.cardEntersChild);
}

/** Keep the click intent until dynamic starcore routes have been registered. */
export function waitsForExtensionRoutes(path: string, extensionsResolved: boolean): boolean {
  return path.startsWith("/extensions/installed/") && !extensionsResolved;
}
export function deferredNavigationOrigin(pending: "click" | null, currentPath: string): "click" | "history" | "initial" {
  return pending ?? (currentPath ? "history" : "initial");
}
