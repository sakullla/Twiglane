import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { trackInputModality } from "./lib/input-modality";

trackInputModality();

const target = document.getElementById("app");
if (!target) {
  throw new Error("缺少应用根节点");
}
mount(App, { target });
