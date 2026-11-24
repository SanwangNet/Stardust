import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryForNavigation, deferredNavigationOrigin, usesRootPageTransition, waitsForExtensionRoutes } from "../apps/web/dist/navigation-transition.js";
import { createNavigationDiagnostics } from "../apps/web/dist/navigation-diagnostics.js";

test("dynamic starcore cards resolve to the starcore category after another category is inserted", () => {
  const menu=[{label:"概览",items:[{path:"/overview/status"}]},{label:"模型",items:[{children:[{path:"/model/service"}]}]},{label:"人物与群组",items:[{path:"/model/people"}]},{label:"星核",items:[{path:"/extensions/installed"}]}];
  for (const path of ["/extensions/installed/qq-bot","/extensions/installed/qq-bot/config","/extensions/installed/navigation-test-star/level-1"]) assert.equal(categoryForNavigation(menu,path,true)?.label,"星核");
  assert.equal(categoryForNavigation(menu,"/model/people",false)?.label,"人物与群组");
  assert.equal(categoryForNavigation(menu,"/model/service",false)?.label,"模型");
  assert.equal(categoryForNavigation(menu,"/unknown",false),undefined);
});

test("entering a child card preserves its expansion across navigation categories", () => {
  assert.equal(usesRootPageTransition({ previousPath: "/overview/status", categoryChanged: true, cardEntersChild: true }), false);
  assert.equal(usesRootPageTransition({ previousPath: "/extensions/installed", categoryChanged: false, cardEntersChild: true }), false);
});

test("ordinary category changes retain their page transition", () => {
  assert.equal(usesRootPageTransition({ previousPath: "/model/chat", categoryChanged: true, cardEntersChild: false }), true);
  assert.equal(usesRootPageTransition({ previousPath: "", categoryChanged: true, cardEntersChild: false }), false);
  assert.equal(usesRootPageTransition({ previousPath: "/model/chat", categoryChanged: false, cardEntersChild: false }), false);
});

test("a card click waits for dynamic route registration without losing its click origin", () => {
  const target="/extensions/installed/qq-bot", pending="click", from="/extensions/installed";
  assert.equal(waitsForExtensionRoutes(target,false),true);
  assert.equal(deferredNavigationOrigin(pending,from),"click");
  assert.equal(waitsForExtensionRoutes(target,true),false);
  assert.equal(deferredNavigationOrigin(null,from),"history");
  assert.equal(deferredNavigationOrigin(null,""),"initial");
  assert.equal(waitsForExtensionRoutes("/model/service/config",false),false);
});

test("animation diagnostics stay silent by default and record completion and cancellation when enabled",async () => {
  let enabled=false, time=10, finish,cancel; const events=[];
  const debug=createNavigationDiagnostics(()=>enabled,(event,data)=>events.push({event,...data}),()=>time);
  const ignored={finished:Promise.resolve()};debug.log("navigation-plan",{from:"a",to:"b"});debug.watch("ignored",ignored);await Promise.resolve();assert.deepEqual(events,[]);
  enabled=true;const done={finished:new Promise(resolve=>finish=resolve)},stopped={finished:new Promise((_,reject)=>cancel=reject)};
  debug.log("navigation-plan",{from:"a",to:"b"});debug.watch("card-border",done,{source:{x:1,y:2,width:3,height:4}});debug.watch("root-frame",stopped);time=25;finish();cancel(new Error("cancelled"));await Promise.resolve();
  assert.deepEqual(events.map(e=>e.event),["navigation-plan","animation-start","animation-start","animation-finish","animation-cancel"]);
  assert.equal(events[3].elapsed,15);assert.equal(events[4].name,"root-frame");
});
