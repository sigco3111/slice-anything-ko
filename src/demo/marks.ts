// Where load time goes: named moments since the page started, read back by scripts/load.mjs.
export const marks: [string, number][] = [];
export const mark = (name: string): void => {
	marks.push([name, performance.now()]);
};
