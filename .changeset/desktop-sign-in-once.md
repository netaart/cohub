---
"@neta-art/cohub-cli": patch
---

Desktop sign-in: requests that arrive together, such as from several windows on launch, now share one device code and open the browser once. Before, each one opened another sign-in page, and each open reset the form in the pages before it, so Logto showed "Session not found" there. Asking again more than 10 seconds later still reopens the page.
