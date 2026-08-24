# Writing in an established setting

Some stories are set in a world someone else published: Forgotten Realms, Azeroth, the Star Wars galaxy, a tabletop campaign setting your group already plays in. The canon is fixed, you did not write it, and you want the Assistant to notice when your draft contradicts it.

Codex handles this in two parts. Tick a switch so the Assistant knows the setting is not yours to invent, and put the canon you care about into your universe so it has something exact to check against.

## Mark the universe as an established setting

Open the universe's settings and tick "Established setting". The Assistant then treats the world as one it may already know, and checks your manuscript against that knowledge as well as against your own notes. Where the two disagree, your material wins: a story that deliberately breaks canon is a choice, not a mistake, and the Assistant is told as much.

Leave the switch off for a world you invented. The Assistant then trusts nothing but what you have written down, which is what you want when the setting is yours.

## Put the canon you care about into your lore

The switch alone leans on whatever the model happens to know, which varies by model and is never complete. Anything you actually want checked, write down as lore.

Create lore entries for the canon facts your story leans on, the same way you would for a world of your own:

- The places your characters move through, with the details that matter: which river runs where, how long the road takes, who holds the city.
- The organisations, and who leads them in the year you are writing.
- The rules of the setting's magic or technology, including the limits your plot depends on.
- The canon characters who appear, with the traits and history you need to stay consistent with.

Give each one keywords, so the editor recognises the name in your prose and the Assistant picks the entry up when it reviews a scene that mentions it. Keep the entries short and factual: what is true, not an essay about the setting.

Once the canon is in your lore, checking a draft against it is the ordinary continuity check. The Assistant reads your scenes against the lore entries, and a contradiction shows up as a comment like any other. It works the same on every endpoint, including a model running on your own machine that has never heard of the setting.

## Where your changes to canon live

Write your own version as the lore entry. If your campaign burned down a canon inn in 1372, the entry for that inn says so, and the Assistant checks your scenes against your version rather than the published one. Note the change in the entry's body so the reason survives; you will not remember in six months why the inn is a ruin.

This is why the two parts work together. The switch tells the Assistant the world has a canon it may know; the lore tells it what is true in yours.

## Letting Claude look things up

On the Claude provider there is one more option, off unless you turn it on: "Let the assistant search the web", on your account's Assistant page. With it on, Claude may search when it reviews your work or answers you in the side panel, in a universe you have marked as an established setting, so it can check a detail rather than rely on what it happens to remember. It never searches while writing inline suggestions or drafting a passage, where waiting on a search would be worse than the answer is worth, nor during background work.

The search runs on Anthropic's servers and comes back as part of Claude's answer, and Anthropic bills you for it, separately from the tokens. Each request may make up to five searches, and a review of a whole story is many requests, so leave this off if you are watching costs closely: a spend cap counts tokens and cannot see searches. It is worth turning on when your setting is well documented online and you are tired of the model half-remembering it. It is not a substitute for lore: a search finds what the web says, while your lore says what is true in your version, and only one of those is authoritative for your story.

Every other endpoint ignores this setting.

## What Codex does not do

Codex does not go looking for canon on its own. It has no library of published settings, and apart from the Claude option above, nothing it does reaches beyond the endpoint you configured. Everything the Assistant knows about a setting comes from the model you configured plus the lore you wrote, which is why the lore is worth the effort for anything you want caught reliably.

Nor does Codex import canon for you. Copying a published sourcebook wholesale into your universe is a copyright question, and one only you can answer for your situation. Short factual entries in your own words, for the things your story touches, are what this is for.
