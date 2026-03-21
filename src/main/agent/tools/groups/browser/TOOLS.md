# Tool Definitions — Browser Group
# ═══════════════════════════════════
# Browser tools operate the Electron Chromium browser visible in the right panel.
# The user can see every navigation. Also includes DOM-based extraction.
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
  Extract targeted structured data from the current page. Pass a natural
  language instruction describing what to extract: "the pricing table",
  "all navigation links", "form fields", "product prices". More efficient
  than parsing raw browser_read_page output for specific data.

input_schema:
  type: object
  properties:
    instruction:
      type: string
      description: What to extract — be specific (e.g. "pricing table", "form fields", "navigation links")
  required: [instruction]


## browser_focus_field

name: browser_focus_field
description: |
  Explicitly focus a form field by CSS selector, scrolling it into view
  first. Use before browser_type when you need to guarantee the correct
  field is active. Returns focus confirmation or error. More reliable
  than clicking for form fields.

input_schema:
  type: object
  properties:
    selector:
      type: string
      description: CSS selector of the field to focus (e.g. "#email", "input[name=username]", "[aria-label=Search]")
  required: [selector]


## browser_detect_form

name: browser_detect_form
description: |
  Detect forms on the current page and return their structure with stable
  CSS selectors for each field. Use before filling complex forms — returns
  field names, types, placeholders, and reliable selectors (by id/name/aria)
  instead of fragile element indices. Also returns the submit button selector.

input_schema:
  type: object
  properties:
    instruction:
      type: string
      description: Optional hint to match a specific form (e.g. "login", "search", "signup"). Leave empty to detect all forms.
  required: []


## browser_fill_field

name: browser_fill_field
description: |
  Fill a single form field using native browser input events. This is
  the most reliable way to type into ANY form field: React inputs, Web
  Components (Reddit, GitHub), rich text editors (Lexical, ProseMirror),
  and contenteditable divs. Uses real Chromium input pipeline — identical
  to human typing. Automatically scrolls into view, clicks to focus, clears
  existing text, types char-by-char, and verifies the result.
  
  PREFER THIS over browser_click + browser_type for all form filling.
  For Web Components, pass the outer element selector — shadow DOM drilling
  is automatic.

input_schema:
  type: object
  properties:
    selector:
      type: string
      description: CSS selector for the field (e.g. "input[name=email]", "[name=title]", "div[name=body]")
    text:
      type: string
      description: Text to type into the field
  required: [selector, text]


## browser_run_harness

name: browser_run_harness
description: |
  Execute a stored site harness for deterministic, zero-cost form filling.
  Harnesses are pre-compiled form definitions with exact CSS selectors.
  They execute via native browser input without any LLM calls — 2-5 seconds total.
  
  Check the dynamic prompt for available harnesses on the current site.
  If no harness exists, fill manually with browser_detect_form +
  browser_fill_field, then call browser_register_harness to save it.

input_schema:
  type: object
  properties:
    domain:
      type: string
      description: Site domain (e.g. "reddit.com")
    action:
      type: string
      description: Harness action name (e.g. "create-post")
    fields:
      type: object
      description: Field name → value map (e.g. {"title": "My post", "body": "Hello"})
    submit:
      type: boolean
      description: Click submit button after filling (default false)
  required: [domain, action, fields]


## browser_register_harness

name: browser_register_harness
description: |
  Register a new site harness after successfully filling a form. Saves the
  form structure (field selectors, types, submit button) so next time the
  same form can be filled deterministically via browser_run_harness.
  Call after successfully filling a form with browser_detect_form +
  browser_fill_field.

input_schema:
  type: object
  properties:
    harness:
      type: object
      description: |
        Harness definition with: domain, actionName, urlPattern,
        fields (array of {name, selector, fieldType, required}),
        submit ({selector, text}),
        verify ({successUrlPattern?, errorSelector?})
  required: [harness]


## browser_screenshot

name: browser_screenshot
description: |
  Capture a screenshot of the current browser viewport. Returns the image.
  Use when you need to see visual layout, identify icon-only buttons, or
  verify that an action succeeded visually. After reviewing the screenshot,
  use browser_click with an element index or CSS selector to interact.

input_schema:
  type: object
  properties: {}
