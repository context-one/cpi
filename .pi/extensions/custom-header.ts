import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setHeader((_tui, theme) => {
        return {
          render(_width: number): string[] {
            return [
              "",
              theme.fg("accent", "  ██████╗ ██████╗ ██╗"),
              theme.fg("accent", "  ██╔════╝██╔══██╗██║"),
              theme.fg("accent", "  ██║     ██████╔╝██║"),
              theme.fg("accent", "  ██║     ██╔═══╝ ██║"),
              theme.fg("accent", "  ╚██████╗██║     ██║"),
              theme.fg("accent", "   ╚═════╝╚═╝     ╚═╝"),
              theme.fg("muted", "  contextone agent – v1.0"),
              "",
            ];
          },
          invalidate() {},
        };
      });
    }
  });
}
