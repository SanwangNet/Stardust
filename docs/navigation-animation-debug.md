# 导航动画诊断

诊断默认关闭，不改变正常动画的时长、缓动或 DOM 操作。需要复现时，在 Stardust 页面按 F12 打开开发者工具，在 Console 中执行：

```js
localStorage.setItem("stardust.navigation.debug", "1");
location.reload();
```

重新进入出现问题的根页面，点击卡片，等待动画结束，再通过返回操作回到根页面。Console 中筛选 `[stardust-navigation]`，复制从 `intent` 到 `animation-finish`／`animation-cancel` 的记录；若能复现，也请附上出现问题的页面、点击目标和当时是否滚动过页面。

记录包含导航来源及目标路径、分支选择、源卡片和目标容器尺寸、DOM 重建和下一帧布局、动画时长与开始／结束／取消时间、跳过及清理原因。它不记录页面正文、表单内容或模型消息；路径可能包含自定义星核标识，分享前可检查并遮盖。

完成后关闭诊断：

```js
localStorage.removeItem("stardust.navigation.debug");
location.reload();
```
