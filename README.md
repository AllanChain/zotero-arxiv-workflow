<p align="center"><img src="./addon/chrome/content/icons/favicon.svg" width="200"></p>
<h1 align="center">arXiv Workflow for Zotero</h1>
<p align=center>
  <a href="https://github.com/AllanChain/logseq-live-math/releases">
    <img src="https://img.shields.io/github/v/release/AllanChain/zotero-arxiv-workflow" alt="GitHub release">
  </a>
  <a href="https://github.com/windingwind/zotero-plugin-template">
    <img src="https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?logo=github" alt="Using Zotero Plugin Template">
  </a>
  <img src="https://img.shields.io/github/downloads/AllanChain/zotero-arxiv-workflow/total" alt="total downloads">
</p>

This Zotero plugin addresses the pain when you store papers from arXiv and want to update your Zotero entry when they are published.

> [!Warning]
> This plugin is in alpha stage and only suports Zotero 7 beta!

## ✨ Features

- 🪢 Merge a preprint item and a journal article item without pain
- 🗃️ Easy to set which PDF to open by default
- 📄 Search online if a arXiv paper is published and update the information and PDF accordingly
- 🌐 Download the latest version of published PDF

## 🤔 Why?

Easier workflow with arXiv paper!

- The Zotero built-in merging feature does not support merging items of different type, therefore an arXiv paper and a journal article cannot merge.
- I need the journal information from the journal item, while keeping the ID the same as the arXiv one. Because many plugins store data based on item ID, and I do not want to lose them.

## 🪐 How?

This plugin focusing on the following workflow:

- One parent item for both arXiv and published version.
  - Keeping both items and relating them is also possible in Zotero, but not the focus of this plugin.
- Item ID from the preprint item is used.
  - Some plugins store data based on item ID.
- Metadata from the published version is used.
  - Usually, only the metadata of the publish version is needed to cite.
  - However, something like the creation date follows the preprint item.
  - The URL for the preprint is kept in the snapshot or web link attachment.
- PDFs from both versions are kept.
  - In case there are some annotations on the preprint PDF.
  - And it is configurable which PDF to open by default.

The main logic of the merging process is demonstrated by the following plot:

```
Before:                                     After:
====================                        ====================
ItemID A (preprint)                         ItemID B
--------------------                        --------------------
Metadata A:                                 Metadata A:
Date added (A)                              Date added (B)
URL (A)                                     URL (A)
...                                         ...
--------------------               \        --------------------
PDF attachment a*         ----------\       PDF attachment a*
...                       ----------/       PDF attachment b
====================               /        Web Link attachment
ItemID B (published)                        ...
--------------------                        ====================
Metadata B
Date added (B)                              * means prefered PDF
URL (B)
...
--------------------
PDF attachment b*
...
====================
```

## 📸 Screenshots

|          Merge arXiv           |          Prefer PDF           |
| :----------------------------: | :---------------------------: |
| ![Screenshot of merge arXiv][] | ![Screenshot of prefer PDF][] |

[Screenshot of merge arXiv]: https://github.com/AllanChain/zotero-arxiv-workflow/assets/36528777/ebd7bb02-9caf-4e32-8f42-2afa7f119354
[Screenshot of prefer PDF]: https://github.com/AllanChain/zotero-arxiv-workflow/assets/36528777/fe0dc757-6dbe-4d8b-894c-f806644686c7

## 🔧 Installation

Download `zotero-arxiv-workflow.xpi` from the [release page](https://github.com/AllanChain/zotero-arxiv-workflow/releases). Firefox users need to right-click on the link and use "Save link as" instead of direct downloading it. After downloading, click "Tools" > "Plugins" in Zotero menu and drag the downloaded file into the dialog.

## 🎈 How to Use

### 🪢 Merge arXiv paper and the published one

1. Save the arXiv version into Zotero
2. Save the published version into Zotero
3. Select both items, right click
4. Select "Merge arXiv"

This will update the arXiv item with all the information from the journal item except for the `URL` and `dateAdded`. The journal item will be deleted and the original arXiv item will have type `journalArticle`.

This will also make the published PDF as the default PDF.

### 🗃️ Prefer to open a specific PDF

If you have merged some entries manually, those entries will by default open the arXiv PDF. To make Zotero open the published PDF by default, you can select the published PDF, right click, and select "Prefer this PDF".

### 📄 Search for published version of an arXiv paper

If you have a preprint item for the arXiv paper, and you want to find if it has been published and update the information, you can right click on the preprint item and select "Update to a published one". This will search `arxiv.org` for the "Related DOI" field, which may be updated if the paper got published. If nothing is found, we will fall back to the [Semantic Scholar](https://www.semanticscholar.org) API.

> [!Note]
>
> It is not trivial to correctly find the published version. If it fails, you'd better add the journal article item manually and use the merge feature this plugin provides.

If a published version is found, a new item will be created automatically and the published PDF will be downloaded. Then the preprint item and the newly created journal item will be merged with the same logic as mentioned earlier.

### 🌐 Download published PDF

Say you have an arXiv paper PDF and import it into Zotero. Zotero finds that it has been published and uses the information from the published version. A few days later you might want to download the published version because it might be different from the arXiv one. With original Zotero, you have to open the journal URL, download the PDF, and add it as an attachment. With this plugin, it is as easy as right click and select "Download published PDF".

## 💻 Development

This repo is created from the [Zotero plugin template](https://github.com/windingwind/zotero-plugin-template), please follow the [quick start guide](https://github.com/windingwind/zotero-plugin-template?tab=readme-ov-file#quick-start-guide).

The following resources are also helpful:

- [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero Plugin Development](https://www.zotero.org/support/dev/client_coding/plugin_development)
