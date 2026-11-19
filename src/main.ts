import { mount } from "svelte";
import App from "./App.svelte";
import AppContextMenu from "./lib/components/AppContextMenu.svelte";
import "./app.css";
import { trackInputModality } from "./lib/input-modality";

trackInputModality();

const target = document.getElementById("app");
if (!target) {
  throw new Error("缺少应用根节点");
}
mount(App, { target });
// 全局右键兜底：单独挂在 body 上，不占用应用外壳；组件自己的右键菜单优先。
mount(AppContextMenu, { target: document.body });
