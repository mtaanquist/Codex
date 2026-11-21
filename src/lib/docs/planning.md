# Planning your world

The planning view holds everything your stories draw on: characters, places, and lore. These belong to the universe, so every story in it can use them.

## Characters, places, and lore

To create an entry, select the Add row under its group in the sidebar ("Add character", "Add place", or "Add" followed by a lore category's name, such as "Add Lore entry"), type a name, and press Enter. Press Escape to close the field without creating anything. Give the new entry a short summary. The summary is what shows when someone hovers a mention in the editor. Add longer notes in the body. The field at the top of the sidebar filters every list by name as you type. While it has text in it, the Add rows and "Manage categories" are hidden, so clear it to add an entry.

In a story's planning view, characters and places from the rest of the universe are listed under "In the universe". To bring one into the story, select "Add a character from the universe" (or "Add a place from the universe"), pick it, and select "Add to this story".

Lore entries are grouped into categories you define, such as "Factions" or "Magic". A category's colour is the colour its entries are underlined in. Select "Manage categories" at the foot of the sidebar to open them in the universe settings, where you can rename them, pick their colours, reorder them, and add or delete them. A category can only be deleted once nothing uses it.

## The entity badge

Every entry has a badge: the small coloured square with its first letter, shown beside its name everywhere. By default it takes its colour from the entry's category. To change one entry on its own, open it and click its large badge at the top. The menu lets you pick a colour from the palette, or, when image storage is set up, upload an image to use instead. Pick "Default" to drop a custom colour and go back to the category's. When an image is set, the menu offers to remove or download it.

## Renaming

Renaming an entry does not rewrite your prose by itself: the old name simply stops being recognised as a mention. After a rename, the entry's page offers to replace the old name across your scenes, telling you how many places it would touch. The replacement matches the exact name as a whole word, leaves aliases alone, and records a checkpoint in each changed scene's History so you can undo it.

## Aliases

Give a character their nicknames and variants as aliases. Type one and press Enter to add it; click the cross on an alias to remove it. The editor uses them to detect mentions, so "the Captain" can point at the same person as her name. Lore entries take keywords the same way.

Your changes save on their own as you work, so there is no save button.

## Details

Details are short facts about an entry, each with a label and a value: Status, Age, Allegiance, whatever fits. Select "Add detail" to add a row, and fill in both fields; rows missing either are not kept. The first three details show when you hover a mention in the editor, in the order they appear here, so put the most useful ones on top.

## Assistant suggestions

When you have set up the Assistant on your account page, an entry's page shows "Suggest details with the Assistant". Select it and the Assistant reads every scene that mentions the entry, along with the scene before and the scene after each one, and proposes new aliases, quick details, and a summary if it has none and you have not rejected one. Because it reads whole scenes, it can pick up a nickname or a description that does not use the entry's name. In a story's Plan it reads that story; in the universe's Plan it reads every story in the universe. The read runs in the background, so you can keep working or leave the page: a card in the corner shows it is running, with "Stop" to end it, and you get a notice when it is done. If the entry is still open then, the new suggestions appear on it. If you close the card, select "Background jobs" in the top bar, next to your notifications, to see the read and stop it from there. A small read starts at once. For a larger one you first see how many scenes it covers, roughly how many tokens that sends, and the cost when your model has a price; select "Read" to go ahead or "Cancel" to stop. Text that is too long for your model to take at once is read in several parts, and the count says how many. A read stops at your spend cap for background work, if you have set one. When the whole story fits your model, "Read the whole book" appears next to the button after you have used it once on that page. Use it for an entry that is described in scenes that never name it. If the Assistant stops partway, or you stop it, you keep the suggestions from the parts it read, and the notice says how many. Each suggestion shows with Accept and Reject buttons: accept adds it to the entry, reject discards it, and the Assistant will not suggest a rejected item again. To get suggestions for every entry in a universe at once, type `/enrich` in the Assistant tab. That pass reads only a short passage around each mention, to keep its cost down, so use the button on an entry when you want a closer read. You get a notice when the pass is done, saying how many entries could not be read. If three entries in a row fail, or you turn the Assistant off, the pass stops early; check the endpoint on your account page, or turn the Assistant back on, then type `/enrich` again to carry on from where it stopped. Nothing changes until you accept, and an accepted suggestion is recorded in History like any other edit, so you can roll it back.

## Suggested entries and scene splits

Your Assistant, or an app you connected on your account page, can suggest a character, place or lore entry that your writing mentions but your universe does not have yet. A connected app can also propose splitting a scene in two. Both wait for you in the universe's settings: open the universe's settings and select Suggestions. The link shows a number when something is waiting.

Each suggested entry shows its name, what kind of entry it is, who suggested it, and a short description and where it was seen when those were given. Select Accept to add it to the universe, with the description as its summary; you can then open it in Plan and change anything. A lore entry is filed under your first category, so add a category first if the universe has none. Select Dismiss to drop the suggestion; a dismissed name is not suggested again.

Each proposed split shows the scene, the reason, and the words the new scene would start at. Select "Split here" to split the scene at those words, the same as splitting it yourself in the editor, or Dismiss to leave the scene as it is. If you have changed the scene so that those words are gone, the split cannot be made; dismiss it.

Nothing is added or split until you choose.

## Character arcs

A character's page has an "Arc across the stories" section. Select "Write arc" and the Assistant reads every scene the character appears in, across all the stories in the universe, and writes a few sentences on what happens to them. It runs in the background and notifies you when it is done. When something the arc was written from changes, the section says the arc is out of date; select "Refresh arc" to write it again. That covers the text around the character's first mention in a scene, a scene's summary or title, the order of their scenes, a scene or story that is deleted, merged away or restored, a story's title, the character's name, and turning the Assistant off or back on for a story they appear in. Any edit to a scene whose summary the Assistant wrote also counts, until "Update summaries" has run again and the summary comes out the same. An edit elsewhere in a scene that has no summary, or a summary you wrote, leaves the arc as it is. The Assistant still reads an arc that is out of date, but treats your scenes as right where the two differ. It does not read an out-of-date arc at all while the Assistant is turned off for a story the arc was written from, or while such a story is in the trash or after it is deleted for good; select "Refresh arc" to write one it can read. "Refresh arc" on an arc that is up to date writes a new take. The arc is kept apart from your own summary and description, and the Assistant uses it to keep track of the character when you chat or ask it for help.

## The Assistant panel

When you have set up the Assistant on your account page, the right column of the plan gains an Assistant panel, next to Reference and History. It is a chat grounded in your world, so you can ask questions and work through ideas while you plan.

On a story's plan, the panel talks about that story, and it shares the story's chats with its Write and Review views: a chat you start in one is listed when you open another. On a universe's plan, the panel talks about the whole universe and keeps its own chats. See [the editor article](/docs/editor) for starting, switching and deleting chats.

The Assistant can read across every story in the universe, not just the one in front of you. So while you plan a new book you can ask it to check a detail, an event, or a character against the earlier ones, and it will find the scene it comes from and tell you where. Ask it to check continuity across the stories and it will look for facts, timelines, and character details that disagree between the books.

If you do not want the Assistant on a particular story, open its panel and choose "Mute for this story" from the command menu (the slash button at the bottom of the chat box); the panel stays so you can turn it back on, and the Assistant leaves that story's scenes out when it works across the universe. To turn the Assistant off everywhere, use the master switch on your account page.

## Relationships

You can record how entities relate: who is whose parent, which faction holds which city. Select "Add relationship", pick a type, choose the other entity, and add a note if you like; the reverse shows on the other entry's page automatically. Click a related entity to jump to it.

## Bringing entities into a story

An entity joins a story when you create it while working in that story, or when you add it by hand. The story's plan then shows just the characters, places, and lore that belong to it.

## The scene board

A story's plan shows its scenes as cards on a board when nothing else is open. The columns are the four stages a scene can be in: outline, draft, revised, and final. Drag a card to another column to change its stage, or use the arrows that appear on the card. Each card shows the scene's chapter, its word count, and how many TODO markers are still open in it. Click a card's title to open the scene in the editor. To plan a scene before writing it, create it, set its card to the outline column, and put the beats in the scene body.

## The story board

A universe's plan shows its stories the same way when nothing else is open: each story sits in the column matching how far along it is, judged from its scenes. This board is an overview, so the cards are not draggable; a story moves columns as its scenes do. Click a card's title to open the story.

## Insights

Open Insights from the universe crumb in the top bar, or search for it with Ctrl+K. The page shows how the writing is going and how much of the world the prose uses. Insights reads the whole universe, so none of the four modes is current while you are there; pick one from the strip on the left to go back to the work, and use the list under it to jump between the page's sections.

Writing sessions shows what you have written today, how many of the last 30 days and last 7 days you wrote on, and your progress towards a daily word goal. If the streak is not for you, hide it under Editor behaviour on your account page.

Progress shows total words, net words written this week, your writing streak, and a chart of words per day for the last 30 days. A day counts towards the streak when you saved any scene that day. Each story below shows its word count and how its scenes split between outline, draft, revised, and final.

If you set a daily word goal on your account page, Progress also shows today against it and how many of the last 30 days met it. Give a story a target length or a deadline in its settings under Goals, and each story shows its progress towards the target and how long until the deadline.

The world heatmap lists every character, place, and lore entry, brighter the more often the prose mentions it. A pale tile is an entry no scene mentions yet, and "no entry" marks one with nothing written in its body. Click any tile to open that entry in the plan.

The relationship web draws every recorded relationship as a map: entities are dots, sized by how connected they are, and the lines between them are the relationships. Hover a dot to read its connections, click it to open the entry. The buttons above filter by kind of relationship, and the select narrows the web to one entity and its direct connections.

## Notes

The Notes view holds freeform writing notes: ideas, threads to pull, anything that does not belong to one character or place. Open it from the Notes panel on the right of the Write and Plan views: select a note there, or "All notes", to land on the full Notes page. The command palette also jumps there with "Story notes" and "Universe notes".

A note in a story belongs to that story. A note in a universe belongs to the whole universe and shows in every story under it, under "From the universe" in the story's note list; open one there to jump to it and edit it in the universe view. Select "New note" to make one, give it a title, and write in the body. Notes save on their own as you type.

Pin the notes you reach for often with the Pin button above a note; pinned notes sit at the top of the list. Delete removes a note for good. The filter field at the top of the list narrows it by title.

If you run a campaign, a note per sitting works well: keep the running log in a story note, and world facts the players have learned in a universe note. The right pane of the Notes view keeps past versions of the open note, the same way it does for scenes and entries; a note mentions nothing and has no comments, so History is the only panel there.

A note can also be attached to one scene. In the editor, open the Notes panel on the right and select "New note on this scene": the note is made, attached, and opened in the Notes view for you to write. From then on it shows at the top of the Notes panel whenever the scene is open, and in the story's note list like any other note.

To jot something down without leaving the editor, press Ctrl+Alt+N or run "Quick note" from the command palette. A small card opens over the editor: write the thought, then Ctrl+Enter or "Save note" files it with the story's notes - attached to the open scene when there is one - and puts you back where you were. The first line becomes the note's title.

## History

The History panel on the right keeps past versions of the open entry. Every change counts: the name, aliases, summary, category, details, and relationships, not just the body text. Use "Checkpoint now" to mark a version you may want back, with a name if you like. Every saved version is kept.

Select "Preview" on a version to read it; the panel above the text lists the fields as they were then. "Restore this version" brings the whole entry back to that state, including its relationships. Restoring never deletes history: the version you replaced stays in the list, so you can return to it the same way.
