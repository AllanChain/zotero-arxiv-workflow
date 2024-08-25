<p align="center"><img src="./addon/chrome/content/icons/favicon.svg" width="200"></p>
<h1 align="center">arXiv Workflow for Zotero</h1>
<p align=center>
  <a href="https://github.com/AllanChain/zotero-arxiv-workflow/releases">
    <img src="https://img.shields.io/github/v/release/AllanChain/zotero-arxiv-workflow" alt="GitHub release">
  </a>
  <a href="https://github.com/windingwind/zotero-plugin-template">
    <img src="https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?logo=github" alt="Using Zotero Plugin Template">
  </a>
  <img src="https://img.shields.io/github/downloads/AllanChain/zotero-arxiv-workflow/total" alt="total downloads">
</p>

This Zotero plugin addresses the pain when you store papers from arXiv and want to update your Zotero entry when they are published.

> [!Warning]
> This plugin is in alpha stage and only suports Zotero 7!
>
> I strongly recommend you to check the results manually after operations.

## ✨ Features

- 🪢 Merge a preprint item and a journal article item without pain
- 🗃️ Easy to set which PDF to open by default
- 📄 Search online if a arXiv paper is published or updated and update the information and PDF accordingly
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

## 🎈 Explanation of each feature

### 🪢 Merge arXiv paper and the published one

The main logic of merging items is described [above](#-how). A few points to emphasis:

- Select and only select two items: an arXiv paper and its published version.
  - Do NOT select anything else, including any attachments of an item.
- An item is considered published if it has type "Journal Article" or "Conference Paper".
- The item for published version is deleted and the item for arXiv version will have updated info and attachments.
- If the titles of these two items are different, a dialog will popup to ask user confirmation.

<details>
<summary>JavaScript API</summary>


```typescript
async Zotero.arXivWorkflow.merge(
  preprintItem: Zotero.Item,
  publishedItem: Zotero.Item,
  suppressWarn = false,
)
```

This function assumes that the first argument is an arXiv version and the second is the published one. Currently, no checks will be performed to ensure this. The function caller is responsible to make sure the `type` of items is correct.

If `suppressWarn` is `true`, no confirmation dialog will popup if the title of two items are different.

</details>

### 🗃️ Prefer to open a specific PDF

Maybe you have merged some items manually before. Or maybe you just want to change the default PDF to open.
Either case, you will find the "Prefer PDF" feature useful.
To use this feature, select (and only select) the PDF you want to open by default, right click, and select "Prefer this PDF".

<details>
<summary>
Under the hood, this plugin does something "dirty".
</summary>


That is because Zotero does not have the functionality of setting the default PDF to open.
It determines the PDF to open by checking and sorting by:
- The attachment is a PDF
- The URL field of the PDF matches the URL of the parent item
- `dateAdded` of the PDF
Or in SQL:

```sql
ORDER BY contentType='application/pdf' DESC, url=? DESC, dateAdded ASC
```

Therefore, to make Zotero perfer a specific PDF, this plugin
1. sets URL field of the PDF attachment the same as that of parent item
2. sets the `dateAdded` field to be the oldest among all PDFs of parent item
</details>

<details>
<summary>JavaScript API</summary>


```typescript
async Zotero.arXivWorkflow.preferPDF(
  selectedAttachment: Zotero.Item
)
```

This function assumes that the argument is a PDF attachment. Currently, no checks will be performed to ensure this. The function caller is responsible to perform the checks.

</details>

### 📄 Search for updated version of an arXiv paper

If you have a preprint item for the arXiv paper, and you want to find if it has been published on journals or updated on arXiv, and then update the information, you can right click on the preprint item and select "Update arXiv paper". This will search:
1. Published versions by trying:
    1. [arXiv](https://arxiv.org) for the "Related DOI" field, which may be updated if the paper got published
    2. [Semantic Scholar](https://www.semanticscholar.org) API
2. If no published version found, the plugin will search [arXiv](https://arxiv.org) for updated versions

> [!Note]
>
> It is not trivial to correctly find the published version. If it fails, you'd better add the journal article item manually and use the merge feature this plugin provides.

If a published version is found, a new item will be created automatically and the published PDF will be downloaded. Then the preprint item and the newly created journal item will be merged with the same logic as mentioned earlier.

<details>
<summary>JavaScript API</summary>


```typescript
async Zotero.arXivWorkflow.arXivUpdate(
  preprintItem: Zotero.Item
)
```

This function assumes that the argument is an arXiv item, and no checks will be performed to ensure this. The function caller is responsible to perform the checks.

</details>

### 🌐 Download latest PDF

Say you have an arXiv paper PDF and import it into Zotero. Zotero finds that it has been published and uses the information from the published version. A few days later you might want to download the published version because it might be different from the arXiv one. With original Zotero, you have to open the journal URL, download the PDF, and add it as an attachment. With this plugin, it is as easy as right click and select "Download latest PDF".

<details>
<summary>JavaScript API</summary>


```typescript
async Zotero.arXivWorkflow.updatePDF(
  journalItem: Zotero.Item
)
```

This function assumes that the argument is an journal item, and no checks will be performed to ensure this. The function caller is responsible to perform the checks.

Under the hood, this just calls `Zotero.Attachments.addAvailablePDF`.

</details>

## 💻 Development

This repo is created from the [Zotero plugin template](https://github.com/windingwind/zotero-plugin-template), please follow the [quick start guide](https://github.com/windingwind/zotero-plugin-template?tab=readme-ov-file#quick-start-guide).

The following resources are also helpful:

- [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero Plugin Development](https://www.zotero.org/support/dev/client_coding/plugin_development)
