import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import { state } from "../state.js";
import { showWidget, hideWidget, updateWidget } from "./core.js";

/** Open the settings panel. */
export function openSettings(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	void ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const items: SettingItem[] = [
			{
				id: "visible",
				label: "Always-on panel",
				currentValue: state.widgetVisible ? "ON" : "OFF",
				values: ["ON", "OFF"],
			},
			{
				id: "collapsed",
				label: "Panel mode",
				currentValue: state.widgetCollapsed ? "COLLAPSED" : "EXPANDED",
				values: ["EXPANDED", "COLLAPSED"],
			},
		];
		const container = new Container();
		container.addChild(
			new (class {
				render() {
					return [
						theme.fg("accent", theme.bold("Resource Tree Settings")),
						theme.fg("dim", "Enter/Space to change \u00B7 Esc to cancel"),
						"",
					];
				}
				invalidate() {}
			})(),
		);
		const sl = new SettingsList(
			items,
			items.length + 1,
			getSettingsListTheme(),
			(id, v) => {
				if (id === "visible") {
					v === "ON" ? showWidget(ctx) : hideWidget(ctx);
				} else if (id === "collapsed") {
					state.widgetCollapsed = v === "COLLAPSED";
					updateWidget(ctx);
				}
			},
			() => done(undefined),
		);
		container.addChild(sl);
		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(d: string) {
				sl.handleInput?.(d);
				tui.requestRender();
			},
		};
	});
}
