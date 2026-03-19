# Tool Definitions — Browser Group
# ═══════════════════════════════════
# Browser tools operate the Playwright browser visible in the right panel.
# The user can see every navigation. Also includes headless extraction.
# ═══════════════════════════════════


## browser_search

name: browser_search
description: |
  Web search via Google. Returns top 5 results with titles, URLs, and
  snippets. Snippets often contain the answer — check them before clicking
  into pages. Include the current year for time-sensitive queries.

input_schema:
  type: object
  properties:
    query:
      type: string
      description: The search query
  required: [query]


## browser_navigate

name: browser_navigate
description: |
  Navigate to a URL in the visible browser panel. Returns the page title,
  final URL, and visible text content. Do NOT call browser_read_page after
  this — content is already returned. Use for interactive browsing where
  the user should see the page.

input_schema:
  type: object
  properties:
    url:
      type: string
      description: The URL to navigate to
  required: [url]


## browser_read_page

name: browser_read_page
description: |
  Re-read the current page's visible text and interactive elements. Only
  needed if the page changed since last navigation (JavaScript-heavy SPAs,
  after clicking a button that loads new content). Not needed after
  browser_navigate — that already returns page content.

input_schema:
  type: object
  properties: {}


## browser_click

name: browser_click
description: |
  Click an element on the current page. Specify target as: an element
  index number from page content (preferred), a CSS selector, or visible
  button/link text. After clicking, the page may change — read the
  response to see the updated state.

input_schema:
  type: object
  properties:
    target:
      type: string
      description: Element index (e.g. "3"), CSS selector (e.g. "#submit"), or visible text (e.g. "Sign In")
  required: [target]


## browser_type

name: browser_type
description: |
  Type text into an input field on the current page. Targets the currently
  focused input by default. Use selector to target a specific field.
  Does NOT submit forms — click the submit button separately after typing.

input_schema:
  type: object
  properties:
    text:
      type: string
      description: Text to type
    selector:
      type: string
      description: Optional CSS selector to target a specific input
  required: [text]


## browser_extract

name: browser_extract
description: |
  Extract structured data from the current page using a JSON schema.
  Returns data matching the schema shape. Use for pulling prices, tables,
  product details, or any structured information from a page. More
  reliable than parsing raw page text.

input_schema:
  type: object
  properties:
    schema:
      type: object
      description: JSON schema describing the data to extract (e.g. { "prices": [{ "model": "string", "input": "string", "output": "string" }] })
    instruction:
      type: string
      description: Natural language instruction for what to extract
  required: [instruction]


## browser_screenshot

name: browser_screenshot
description: |
  Capture a screenshot of the current browser viewport. Returns the image.
  Use when you need to see visual layout, identify icon-only buttons, or
  verify that an action succeeded visually. Follow up with coordinate-based
  browser_click if you identify a target element in the screenshot.

input_schema:
  type: object
  properties: {}
