/**
 * Permission Gate Extension
 *
 * Intercepts dangerous bash commands (rm -rf, sudo, chmod 777, etc.)
 * and shows a Tab-navigable confirmation dialog.
 *
 * When the user selects an option, supplementary context is sent to the LLM:
 *   - Allowed → prepends an echo with user approval info to the bash command
 *   - Blocked  → includes the user decline info in the block reason
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const log = createLogger("permission-gate");

/** First line of the command, truncated for supplementary message. */
function summarizeCommand(command: string): string {
	const firstLine = command.split("\n")[0].trim();
	return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
}

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [
		/\brm\s+(-rf?|--recursive)/i,
		/\bsudo\b/i,
		/\b(chmod|chown)\b.*777/i,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			log.debug("Ignoring non-bash tool: %s", event.toolName);
			return undefined;
		}

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));
		log.debug(
			"bash command checked: dangerous=%s, cmd=%s",
			isDangerous,
			command.slice(0, 80),
		);

		if (!isDangerous) return undefined;

		// ── No UI fallback ──────────────────────────────────────────────
		if (!ctx.hasUI) {
			log.warn("Dangerous command blocked (no UI): %s", command.slice(0, 80));
			return {
				block: true,
				reason: `Blocked – no UI to confirm dangerous command.\n\`${summarizeCommand(command)}\``,
			};
		}

		// ── Tab-navigable confirm dialog ────────────────────────────────
		const summary = summarizeCommand(command);
		const allowed = await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => {
			let selected = 0; // 0 = No, 1 = Yes
			const options = ["No", "Yes"];

			return {
				render(width: number): string[] {
					const lines: string[] = [];

					// Title
					lines.push(theme.fg("warning", theme.bold("⚠️  Dangerous Command")));
					lines.push("");

					// Command display
					const cmdWidth = Math.max(width - 2, 20);
					const cmdDisplay = truncateToWidth(command, cmdWidth);
					lines.push(theme.fg("dim", "Command:"));
					lines.push(theme.fg("yellow", cmdDisplay));
					lines.push("");

					// Prompt
					lines.push(theme.fg("accent", "Allow this command?"));
					lines.push("");

					// Options — side by side with Tab navigation
					const optionParts = options.map((opt, i) => {
						const isSel = i === selected;
						const marker = isSel ? "●" : "○";
						const label = `${marker} ${opt}`;
						if (!isSel) return theme.fg("dim", label);
						return i === 1
							? theme.fg("success", label)
							: theme.fg("error", label);
					});
					// Center-justify options
					const joined = optionParts.join("    ");
					const padLeft = Math.max(0, Math.floor((width - visibleWidth(joined)) / 2));
					lines.push(" ".repeat(padLeft) + joined);
					lines.push("");

					// Help text
					lines.push(
						theme.fg(
							"muted",
							"Tab/← → navigate  •  Enter confirm  •  Esc cancel",
						),
					);

					return lines;
				},

				invalidate() {
					/* no cached state to clear */
				},

				handleInput(data: string): void {
					if (
						matchesKey(data, Key.tab) ||
						matchesKey(data, Key.right) ||
						matchesKey(data, Key.down)
					) {
						selected = (selected + 1) % options.length;
						_tui.requestRender();
					} else if (
						matchesKey(data, Key.shift("tab")) ||
						matchesKey(data, Key.left) ||
						matchesKey(data, Key.up)
					) {
						selected = (selected - 1 + options.length) % options.length;
						_tui.requestRender();
					} else if (matchesKey(data, Key.enter)) {
						done(options[selected] === "Yes");
					} else if (
						matchesKey(data, Key.escape) ||
						matchesKey(data, Key.ctrl("c"))
					) {
						done(false);
					}
				},
			};
		});

		// ── Supplementary info to LLM ───────────────────────────────────
		if (allowed) {
			log.info("User allowed dangerous command: %s", command.slice(0, 80));
			// Prepend an echo — its output will appear in the bash tool result,
			// providing the LLM with supplementary context about user approval.
			event.input.command =
				`echo "✓ User approved: ${summary.replace(/"/g, '\\"')}"\n${command}`;
			return undefined;
		}

		log.info("User blocked dangerous command: %s", command.slice(0, 80));
		return {
			block: true,
			reason: `🛑 User declined dangerous command.\n\`${summary}\``,
		};
	});
}
