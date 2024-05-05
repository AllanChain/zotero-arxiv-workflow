<p align="center"><img src="./addon/chrome/content/icons/favicon.svg" width="200"></p>
<h1 align="center">arXiv Workflow for Zotero</h1>

This Zotero plugin addresses the pain when you store papers from arXiv and want to update your Zotero entry when they are published.

## Screenshots

|                                                              Merge arXiv                                                               |                                                              Prefer PDF                                                               |
| :------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------: |
| ![Screenshot of merge arXiv](https://github.com/AllanChain/zotero-arxiv-workflow/assets/36528777/ebd7bb02-9caf-4e32-8f42-2afa7f119354) | ![Screenshot of prefer PDF](https://github.com/AllanChain/zotero-arxiv-workflow/assets/36528777/fe0dc757-6dbe-4d8b-894c-f806644686c7) |

## How to use

### Merge arXiv paper and the published one

1. Save the arXiv version into Zotero
2. Save the published version into Zotero
3. Select both items, right click
4. Select "Merge arXiv"

This will update the arXiv item with all the information from the journal item except for the `URL` and `dateAdded`. This will also make the published PDF as the default PDF.

### Prefer to open a specific PDF

If you have merged some entries manually, those entries will by default open the arXiv PDF. To make Zotero open the published PDF by default, you can select the published PDF, right click, and select "Prefer this PDF".
