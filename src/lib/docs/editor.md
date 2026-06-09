# Writing in the editor

The editor is where you draft scenes. It saves on its own as you type, so there is no save button; the status near the top shows when your work was last stored.

The gear in the top bar opens the story's settings: details, cover, page setup, publishing, review links, exports, and more. Clicking the story's title in the breadcrumb goes there too.

## Scenes and chapters

A scene holds one stretch of prose. Chapters group scenes in order. Drag a scene to move it between chapters; scenes without a chapter sit under "Unfiled scenes".

Right-click a chapter in the sidebar to rename it, move it up or down, or delete it. Deleting a chapter keeps its scenes; they move to the unfiled list.

## Splitting and merging scenes

To split a scene in two, put the cursor where the break should go and press the split button in the toolbar (the page with the dashed line). Everything after the cursor moves into a new untitled scene directly after the current one. Marks move along with their text.

To merge scenes, right-click each scene in the sidebar and choose "Select for merging"; selected scenes show a coloured ring. With two or more selected, right-click any of them and choose "Merge". The scenes join in story order into the earliest one, with a blank line between them; that scene keeps its title. The others go to "Deleted scenes", so a merge can be undone by restoring them and removing the joined text.

## Duplicating a scene

Right-click a scene in the sidebar and choose "Duplicate scene" to make a full copy directly after it: the same prose, status, summary, and marks, with "(copy)" added to the title. This is the simple way to keep a scene as a template. Set up a scene the way you want each one to start, then duplicate it and fill in the copy. If you write campaign sessions as scenes, a skeleton scene with your prep headings and to-do marks duplicates into a ready-made next session.

## Deleting scenes

Right-click a scene in the sidebar and choose "Delete scene". A deleted scene goes to "Deleted scenes" at the bottom of the sidebar, where you can restore it or delete it forever. Restoring puts the scene back at the end of its chapter, or in the unfiled list if the chapter is gone. While a scene sits in the trash it does not count anywhere: not in word counts, search, exports, or the story view.

## Formatting

Write markdown and it styles in place: **bold** shows bold, # headings show large, > quotes show muted. The toolbar above the editor sets headings, bold, italic, quotes, and bullet lists on whatever is selected; Ctrl+B and Ctrl+I (Cmd on a Mac) do bold and italic from the keyboard.

The four alignment buttons set how the paragraphs under the selection sit on the page: left (the default), centered, right, or justified. Alignment is written into the text as a small marker at the paragraph's start, like \center, so it travels with exports and shows correctly on reading pages, in EPUB, and in PDF. The marker dims in the editor; choose left to remove it.

The two indent buttons beside them step the selected paragraphs in from the left and back out again (Ctrl+] and Ctrl+[, Cmd on a Mac). Like alignment, the indent is written as a marker (\indent) that rides with the text and shows everywhere, including exports.

There are two ways to see your prose while you write, chosen under Editor behaviour on your account page (and per story in its settings):

- **Rich text**, the default, hides the marks except on the line you are editing, so the page reads like formatted text.
- **Markdown** keeps the formatting marks visible as you type.

Your work is stored as markdown in both modes; switching is purely about what you see while writing.

To force a page break in print and PDF output, put \page alone on its own line. It does nothing on screen or in the reading pages.

## Paragraphs and line breaks

Press Enter to start a new paragraph. One Enter is enough: it reads the same in the editor, the preview, and every export. For a soft line break that stays inside the same paragraph, press Shift+Enter. Inside a bullet list or a quote, Enter continues the list or the quote.

## Showing the hidden marks

The "..." (View options) button on the formatting bar opens two toggles that change what you see without changing your text:

- **Show non-printing characters** shows spaces as a faint dot, paragraph breaks as a pilcrow, and soft line breaks as a return arrow. It is the quickest way to tell a real paragraph break from a soft line break.
- **Show command markers** reveals the markers that ride in the prose, like \center and \indent. They are tucked away by default, so the page reads as the finished formatting; turn this on to see and edit them. (A marker also reappears on its own on the line you are editing.)

Both toggles remember their setting, and you can also set them under Editor behaviour on your account page.

## Reading and previewing the whole story

The book icon at the right of the formatting toolbar opens the whole story as one long document, every scene joined in order. This is still the editor: it has the same formatting toolbar, and you can write anywhere in it. The up and down arrows carry the cursor from the end of one scene into the next. Use the same button again to go back to a single scene.

The two buttons beside it are Focus mode, which clears everything but the page, and Preview.

For a clean read, select Preview. It is on the toolbar in both the single-scene editor and the whole-story view, so you can reach it without opening the whole story first. Preview shows the story the way it will look when exported: no underlines, marks, or alignment markers, just the finished prose with your scene breaks and page setup applied. It is read-only; select Edit to return to writing.

## Find and replace

Press Ctrl+F (Cmd+F on a Mac) in the editor to search the open scene. The panel finds as you type; Enter jumps to the next match, and the replace field swaps one match or all of them. Press Escape to close it. To search across every scene, use Ctrl+K instead.

The field at the top of the sidebar filters the chapter and scene list by name as you type, which is the quick way to find a scene in a long story.

## The selection menu

Select a word or phrase and right-click it for a small menu. The top row formats the selection: bold, italic, quote, bullet list. Below it you can create a new character, place, or lore entry named after the selection, without leaving the page; the new name underlines in the text right away, and you can fill in its details from the planning view later. Lore entries created this way file under your first lore category. Right-clicking without a selection opens the browser's own menu, with its spelling suggestions.

## Mentions

When you write the name of a character, place, or lore entry the universe already knows, the editor recognises it and underlines it in that entry's colour. Hover the underline to see a short summary and the entry's first few details without leaving the page.

For the full picture, select "Open full details" on that hover, or click an entry in the "In this scene" list on the right. A read-only card takes over the right column with the summary, description, relationships, and details. Click a related entry to follow it in the same card, Back to step back, and "Open in Plan view" to edit the entry.

When two entries share a name, the editor picks one: whoever is declared in the story first, then characters before places before lore. Such a mention gets a dotted underline; hover it to see the alternatives, and pick one to make that the meaning of the name everywhere in this story.

If the editor keeps underlining a common word that happens to be a name, open that entry in the planning view and turn off automatic detection for it.

## Marks

To flag a spot to come back to, select some text and add a mark. Marks show in the margin and in the story's to-do list, and you can tick one off when it is done. Typing "TODO:" on a line is also picked up as a reminder; deleting the line clears it.

## History

The History tab on the right keeps past versions of the open scene. Use "Checkpoint now" to mark a version you may want back, with a name if you like. Select "Preview" on a version to read it or compare it with the current text, and "Restore this version" to bring it back. Restoring never deletes history: the version you replaced stays in the list.

## The Assistant

When you have set up the Assistant on your account page, an Assistant tab appears on the right alongside Reference, History, and Session. Open it to chat about the open story: ask about a character, check whether something stays consistent, or talk through a scene. The starter prompts above the box are there to get you going; you can also type your own question and press Enter to send, or Shift+Enter for a new line. While a reply is coming in you can select the stop button to cut it short.

The conversation is not saved. It clears when you reload or leave the page.

While you are writing, press Ctrl+J (Cmd+J on a Mac) to ask the Assistant to continue the passage from where your cursor is. The suggestion appears in grey after the cursor: press Tab to accept it, or Esc (or just keep typing) to dismiss it. Nothing is added until you accept.

You can also ask the Assistant to review a scene: right-click the scene in the left sidebar and choose "Review this scene". It reads the scene and leaves comments and suggested edits, which appear on the review page for you to accept or reject one at a time, the same way a guest reviewer's notes do. Nothing in your scene changes until you accept a suggestion.

To turn the Assistant off for just this book, select "Mute for this story" at the top of the tab. The tab stays so you can turn it back on, but nothing is sent for this story while it is muted. This does not change your other stories or your account setting.

## Spelling

The browser's spell-checker underlines possible misspellings as you write. Set the language your prose is written in on your account page, under Display, so the right dictionary is used; "Follow my browser" uses whatever your browser is set to. Turn spell-check off there if the underlines distract you. Both settings can be overridden per story in the story's settings.

## How it looks

You can change the theme, accent colour, and editor behaviour on your account page, under Display.

A story can override the editor behaviour settings for itself: open the story's settings and use the Editor section. Anything left on "Use my account setting" keeps following your account page.
