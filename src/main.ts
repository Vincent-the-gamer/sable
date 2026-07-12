import { createApp } from "vue";
import App from "./App.vue";
import { initLogger } from "./composables/useLogger";

// 应用启动即开始拦截所有 console 输出，写入前端日志框
initLogger();

createApp(App).mount("#app");
