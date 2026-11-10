import {
	type CohubDebugHar,
	type CohubDebugLogPackage,
	clearCohubDebugLog,
	exportCohubDebugHar,
	exportCohubDebugLog,
	startCohubDebugger,
	stopCohubDebugger,
} from "@neta-art/cohub/debugger";
import { saveFile } from "$lib/downloads.svelte";

declare global {
	interface Window {
		cohubDebugLog: () => CohubDebugLogPackage;
		cohubDebugHar: () => CohubDebugHar;
		cohubClearDebugLog: () => void;
		cohubStopDebugger: () => void;
		cohubSaveDebugLog: () => void;
	}
}

export function installCohubDebuggerConsoleExports() {
	startCohubDebugger();

	window.cohubDebugLog = () => exportCohubDebugLog();
	window.cohubDebugHar = () => exportCohubDebugHar();
	window.cohubClearDebugLog = () => clearCohubDebugLog();
	window.cohubStopDebugger = () => stopCohubDebugger();
	window.cohubSaveDebugLog = () => saveCohubDebugBundle();
}

export function saveCohubDebugBundle() {
	const timestamp = formatDebugFileTimestamp(new Date());
	downloadJsonFile(`cohub-debug-${timestamp}.log`, exportCohubDebugLog());
	downloadJsonFile(`cohub-debug-${timestamp}.har`, exportCohubDebugHar());
}

function downloadJsonFile(fileName: string, data: unknown) {
	const blob = new Blob([JSON.stringify(data, null, 2)], {
		type: "application/json",
	});
	void saveFile({
		key: fileName,
		name: fileName,
		mimeType: blob.type,
		source: () => ({ kind: "blob", blob }),
	});
}

function formatDebugFileTimestamp(date: Date) {
	const pad = (value: number) => String(value).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}
