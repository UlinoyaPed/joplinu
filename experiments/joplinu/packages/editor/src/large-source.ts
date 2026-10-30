import { StreamLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const LARGE_SOURCE_THRESHOLD = 256000;
/** Line-based highlighting avoids reparsing a megabyte-long CommonMark paragraph
 * on every source edit. Rendering and rich/live modes retain the full parser. */
export const largeSourceLanguage = StreamLanguage.define({
	startState: () => ({ fence: '', math: false }),
	tokenTable: { header: tags.heading, code: tags.monospace, strong: tags.strong, emphasis: tags.emphasis, strike: tags.strikethrough, link: tags.link, marker: tags.list, quote: tags.quote },
	token(stream, state) {
		if (stream.sol()) {
			const fence = stream.match(/^ {0,3}(`{3,}|~{3,})/);
			if (fence && typeof fence !== 'boolean') { const marker = fence[1]!; if (!state.fence) state.fence = marker; else if (marker[0] === state.fence[0] && marker.length >= state.fence.length && !stream.string.slice(stream.pos).trim()) state.fence = ''; stream.skipToEnd(); return 'code'; }
			if (state.fence) { stream.skipToEnd(); return 'code'; }
			if (/^\s*\$\$\s*$/.test(stream.string)) { state.math = !state.math; stream.skipToEnd(); return 'code'; }
			if (state.math) { stream.skipToEnd(); return 'code'; }
			if (stream.match(/^ {0,3}#{1,6}\s/)) { stream.skipToEnd(); return 'header'; }
			if (stream.match(/^\s*>\s?/)) return 'quote';
			if (stream.match(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/)) return 'marker';
		}
		if (stream.eatSpace()) return null;
		if (stream.match(/^\\./)) return null;
		if (stream.match(/^`+[^`]*`+/)) return 'code';
		if (stream.match(/^(?:\*\*[^*]+\*\*|__[^_]+__)/)) return 'strong';
		if (stream.match(/^(?:\*[^*]+\*|_[^_]+_)/)) return 'emphasis';
		if (stream.match(/^~~[^~]+~~/)) return 'strike';
		if (stream.match(/^!?\[[^\]]*\]\([^)]*\)/)) return 'link';
		if (stream.match(/^\$[^$]+\$/)) return 'code';
		if (!stream.eatWhile(/[^\s\\`*_~[\]!$#>\d-]/)) stream.next();
		return null;
	},
});
