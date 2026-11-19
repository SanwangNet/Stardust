import { initializeProjectBoard } from "./flow-project-board.js";

export function initializeFlowBoard(): void {
  const host = document.getElementById("flow-board");
  if (host) initializeProjectBoard(host);
}
