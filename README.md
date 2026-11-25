# Inkspire
Requires Python 3.8+. No packages to install (standard library + SQLite).

    python app.py
    # open http://localhost:8000

Structure: app.py (server + API + SQLite), static/ (index.html, style.css, app.js), notes.db (created on first run).

## How tags work
Tags come from headings only (lines starting with #, numbered headings, ALL CAPS lines, Word heading styles ...).
Each heading is split into words; grammar words and filler words are dropped, plurals are folded (sensors -> sensor).
The number on a tag = how many headings use that word, so "Sensors and Perception" + "Proximity Sensors" gives sensor 2.
To hide more words, add them to STOPWORDS or FILLER near the top of the tag section in app.py.

## Editing tags and books
Open a note and click the x next to a tag to remove it (useful when a word is not really important to the subject), or type a word and press Enter to add your own. A note can show at most 12 tags. Removing or adding only changes what is shown for that note; tags are still generated the same way and your changes survive editing the note. In the book view, use Rename or Delete (Delete also removes the notes inside the book).

## Hierarchical template
Pick "Hierarchical tree" when adding a note, then write one item per line and indent (Tab) to put an item under the one above it, like Python:

    Animals
      Mammals
        Dog
        Cat
      Birds
    Plants

It is drawn as a tree diagram: one top item is the root (several top items hang under a root named after the note), and children branch out below their parent. Bullets (- or *) are optional. Tags for these notes come from every item (up to 60). Uploaded .docx bullet levels become indentation too.

## Defining tree nodes
In a hierarchical-tree note, click any node to write its definition (Ctrl+Enter saves, Esc cancels). It is saved to the definitions table, and the word is then underlined with a hover tooltip in every other note that contains it (hand-written definitions win over auto-detected ones). Click the node again to edit or remove it.

## Timeline template
Pick "Timeline", then start every event on a new line with the year and a colon (or " - "). Lines underneath with no year are extra detail for that event:

    1969: Moon landing
      Apollo 11 lands on the Moon.
    1969: Woodstock festival
    1939-1945: World War II
    500 BC: Athens becomes a democracy

Tags for these notes come from the event titles (the text after the year), so related notes and tag counts work too. It is drawn as a line of years in time order. Click a year to see every event for it. Same year twice is fine, they are grouped. Ranges (1939-1945), BC/BCE and "c. 1200" work. Undated lines before the first year are ignored.

## Knowledge graph template
Pick "Knowledge graph", then write one link per line as `A -relation-> B` (no space between - and >; spaces around the whole link):

    Customer -buys-> Product
    Customer -lives_in-> City
    Product -belongs_to-> Category
    Store -located_in-> City
    Brand

It is drawn as circles joined by labelled arrows. Click a circle to see its links, its definition (if you defined it) and the notes that mention it; drag circles to rearrange them. The same name always means the same circle, so the 🕸 button in the top bar merges every graph note you have into one big graph. `A -> B` works without a relation, and a line with just a name adds a lone circle. Circle names become the note's tags, so related notes, search and tag counts work as usual.

## Editing a note
Open a note and click **✏️ Edit** to change its title or text (the book, topic and template stay the same). Tags and auto-detected definitions are recalculated from the new text; definitions you wrote by hand are never touched.

## Search
The search box looks in titles, content and tags. Characters such as `%` and `_` are searched literally.
