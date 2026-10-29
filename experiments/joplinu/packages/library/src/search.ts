import type { Note } from './model';

type Field = 'text' | 'title' | 'body' | 'tag' | 'notebook' | 'type' | 'is';
interface Term { field: Field; value: string; exclude: boolean }
export interface SearchQuery { terms: Term[]; any: boolean }

/** Linear scanner, quoted phrases and escaped quotes; no user-supplied regular expressions. */
export function compileSearch(query: string): SearchQuery {
	const tokens: string[] = []; let word = ''; let quoted = false;
	const bounded = query.slice(0, 4000);
	for (let i = 0; i < bounded.length; i++) {
		const character = bounded[i]!;
		if (character === '\\' && ['"', '\\'].includes(bounded[i + 1] ?? '')) { word += bounded[++i]; continue; }
		if (character === '"') { quoted = !quoted; continue; }
		if (/\s/.test(character) && !quoted) { if (word) tokens.push(word); word = ''; } else word += character;
	}
	if (word) tokens.push(word);
	let any = false; const terms: Term[] = [];
	for (const token of tokens) {
		if (token === 'any:1' || token === 'any:0') { any = token === 'any:1'; continue; }
		const exclude = token.startsWith('-') && token.length > 1; const value = exclude ? token.slice(1) : token;
		const colon = value.indexOf(':'); const name = value.slice(0, colon).toLowerCase(); const argument = value.slice(colon + 1);
		if (colon > 0 && ['title', 'body', 'tag', 'notebook', 'type', 'is'].includes(name)) {
			if (!argument) continue; // A half-typed filter must not throw from the React render path.
			if ((name !== 'type' || ['note', 'todo'].includes(argument)) && (name !== 'is' || ['todo', 'note', 'completed', 'uncompleted', 'pinned'].includes(argument))) { terms.push({ field: name as Field, value: argument, exclude }); continue; }
		}
		terms.push({ field: 'text', value, exclude });
	}
	return { terms, any };
}

export function matchesSearch(note: Note, path: string[], body: () => string, query: SearchQuery, locale: string): boolean {
	const lower = (value: string) => value.toLocaleLowerCase(locale);
	const matches = (term: Term): boolean => {
		const value = lower(term.value);
		switch (term.field) {
		case 'type': return note.kind === value;
		case 'is': return value === 'pinned' ? note.pinned : value === 'todo' || value === 'note' ? note.kind === value : note.kind === 'todo' && (value === 'completed' ? note.completedAt !== null : note.completedAt === null);
		case 'tag': return note.tags.some(tag => lower(tag) === value);
		case 'title': return lower(note.title).includes(value);
		case 'body': return lower(body()).includes(value);
		case 'notebook': return lower(path.join(' / ')).includes(value);
		default: return lower([note.title, ...note.tags, ...path, body()].join('\n')).includes(value);
		}
	};
	const positive = query.terms.filter(term => !term.exclude); const negative = query.terms.filter(term => term.exclude);
	return negative.every(term => !matches(term)) && (!positive.length || (query.any ? positive.some(matches) : positive.every(matches)));
}
