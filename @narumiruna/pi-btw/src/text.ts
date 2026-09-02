export function sanitizeSingleLine(text: string): string {
	return [...text.replace(/[\r\n\t]/gu, " ")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.replace(/ +/gu, " ")
		.trim();
}
