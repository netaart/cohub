import { createContext } from "svelte";

export const [getFilterBarPill, setFilterBarPill, hasFilterBarPill] =
	createContext<() => boolean>();
