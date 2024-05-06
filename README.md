<p align="center"><img src="./addon/chrome/content/icons/favicon.svg" width="200"></p>
<h1 align="center">arXiv Workflow for Zotero</h1>
<p align=center>
  <a href="https://github.com/AllanChain/logseq-live-math/releases">
    <img src="https://img.shields.io/github/v/release/AllanChain/zotero-arxiv-workflow" alt="GitHub release">
  </a>
  <img src="https://img.shields.io/github/downloads/AllanChain/zotero-arxiv-workflow/total" alt="total downloads">
</p>

This Zotero plugin addresses the pain when you store papers from arXiv and want to update your Zotero entry when they are published.

> [!Warning]
> This plugin is in alpha stage and only suports Zotero 7 beta!

## Why?

- The Zotero built-in merging feature does not support merging items of different type, therefore an arXiv paper and a journal article cannot merge.
- I need the journal information from the journal item, while keeping the ID the same as the arXiv one. Because many plugins store data based on item ID, and I do not want to lose them.

## Screenshots

|          Merge arXiv           |          Prefer PDF           |
| :----------------------------: | :---------------------------: |
| ![Screenshot of merge arXiv][] | ![Screenshot of prefer PDF][] |

[Screenshot of merge arXiv]: https://github.com/AllanChain/zotero-arxiv-workflow/assets/36528777/ebd7bb02-9caf-4e32-8f42-2afa7f119354
[Screenshot of prefer PDF]: https://github.com/AllanChain/zotero-arxiv-workflow/assets/36528777/fe0dc757-6dbe-4d8b-894c-f806644686c7

## Installation

Download `zotero-arxiv-workflow.xpi` from the [release page](https://github.com/AllanChain/zotero-arxiv-workflow/releases). Firefox users need to right-click on the link and use "Save link as" instead of direct downloading it. After downloading, click "Tools" > "Plugins" in Zotero menu and drag the downloaded file into the dialog.

## How to Use

### Merge arXiv paper and the published one

1. Save the arXiv version into Zotero
2. Save the published version into Zotero
3. Select both items, right click
4. Select "Merge arXiv"

This will update the arXiv item with all the information from the journal item except for the `URL` and `dateAdded`. The journal item will be deleted and the original arXiv item will have type `journalArticle`.

This will also make the published PDF as the default PDF.

### Prefer to open a specific PDF

If you have merged some entries manually, those entries will by default open the arXiv PDF. To make Zotero open the published PDF by default, you can select the published PDF, right click, and select "Prefer this PDF".
