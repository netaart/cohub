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
