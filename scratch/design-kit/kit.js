// Clones the card's sample template into one pane per theme.
const tpl = document.getElementById('sample');
const themes = document.getElementById('themes');
for (const theme of ['dark', 'light', 'warm']) {
	const pane = document.createElement('div');
	pane.className = 'pane';
	pane.dataset.theme = theme;
	const label = document.createElement('div');
	label.className = 'pane-label';
	label.textContent = theme;
	pane.append(label, tpl.content.cloneNode(true));
	themes.append(pane);
}
