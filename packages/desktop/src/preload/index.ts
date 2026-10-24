import { contextBridge, ipcRenderer } from "electron";
import { toMain, toRenderer, type ToMain, type ToRenderer } from "../main/protocol.js";

// The only door between the panel and the app: validated both ways.
contextBridge.exposeInMainWorld("ani", {
  send(message: ToMain) {
    const parsed = toMain.safeParse(message);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(" "));
    ipcRenderer.send("ani", parsed.data);
  },
  on(listener: (message: ToRenderer) => void) {
    ipcRenderer.on("ani", (_event, raw: unknown) => {
      const parsed = toRenderer.safeParse(raw);
      if (parsed.success) listener(parsed.data);
    });
  },
  onFocus(listener: () => void) {
    ipcRenderer.on("ani-focus", () => listener());
  },
});
