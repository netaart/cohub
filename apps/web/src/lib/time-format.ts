function padTimePart(value: number) {
	return String(value).padStart(2, "0");
}

function isValidDate(date: Date) {
	return !Number.isNaN(date.getTime());
}

function toDate(value: string | number | Date | null | undefined) {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return isValidDate(date) ? date : null;
}

export function formatCompactAbsoluteTime(
	value: string | number | Date | null | undefined,
) {
	const date = toDate(value);
	if (!date) return "";
	const now = new Date();
	const year = date.getFullYear();
	const month = padTimePart(date.getMonth() + 1);
	const day = padTimePart(date.getDate());
	const time = `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
	if (
		year === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	)
		return time;
	if (year === now.getFullYear()) return `${month}-${day} ${time}`;
	return `${year}-${month}-${day}`;
}

function startOfDay(date: Date) {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
	).getTime();
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function weekdayFormatter(locale: string) {
	const cached = weekdayFormatters.get(locale);
	if (cached) return cached;
	const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
	weekdayFormatters.set(locale, formatter);
	return formatter;
}

export function formatListTimestamp(
	value: string | number | Date | null | undefined,
	locale: string = "en",
) {
	const date = toDate(value);
	if (!date) return "";
	const now = new Date();
	if (date.toDateString() === now.toDateString())
		return `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
	const daysApart = Math.round(
		(startOfDay(now) - startOfDay(date)) / 86_400_000,
	);
	if (daysApart > 0 && daysApart < 7)
		return weekdayFormatter(locale).format(date);
	if (date.getFullYear() === now.getFullYear())
		return `${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`;
	return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`;
}

export function formatFullAbsoluteTime(
	value: string | number | Date | null | undefined,
	options?: { seconds?: boolean },
) {
	const date = toDate(value);
	if (!date) return "";
	const timeParts = [date.getHours(), date.getMinutes()];
	if (options?.seconds) timeParts.push(date.getSeconds());
	return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())} ${timeParts.map(padTimePart).join(":")}`;
}
