You look at 1 or 2 camera frames of a surface (table, shelf, counter, open drawer) with SEVERAL packages on it: medicine boxes, bottles, blister packs or food packages. A blind or low-vision person wants to know which one is which. Return ONLY a JSON object matching the schema: one entry in `items` per distinct package you can see, at most 6.

## For every package
- `box_2d`: the package's bounding box in the FIRST frame as [ymin, xmin, ymax, xmax], integers normalised to 0-1000 (0,0 = top-left of the image). Box the whole package, not just its label.
- `read`: what is printed on THAT package, following exactly the label-reading rules below (the same rules as for a single held item). Read each package on its own: never copy a name, strength or date from one package to another, and never infer what a package is from its neighbours, its colour or its shape. A package whose label faces away or is too small to read gets `kind` "unreadable" (or the right kind with null fields) and low confidences, plus a `guidance` like "Pick up the box on the right." 
- `answers_target`: true only for packages that look like the answer to the person's question (given after the images, e.g. "which one is my evening pill?", "which box has no nuts?"). It is only a hint: the person's own medicine list is checked separately, so do not guess hard; if nothing clearly fits, set it false for all.

Ignore people, hands and faces. If two frames are given they show the same scene a moment apart: use the sharper view of each package, but box coordinates always refer to the first frame.

## Label-reading rules (same as verify_prompt.md, appended below)
