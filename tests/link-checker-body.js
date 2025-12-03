const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function checkAllLinks(url) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Create screenshots directory if it doesn't exist
  const screenshotsDir = './broken-link-screenshots';
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
  }

  console.log(`Navigating to: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });

  // Get all links with their selectors
  const links = await page.evaluate(() => {
    // Only get links from the body, exclude header and footer
    const bodyElement = document.body;
    const anchors = Array.from(bodyElement.querySelectorAll('a[href]'));
    
    // Filter out links in header and footer
    return anchors
      .filter(a => !a.closest('header') && !a.closest('footer'))
      .map((a, index) => {
        // Add a unique data attribute for identification
        a.setAttribute('data-link-checker-id', `link-${index}`);
        return {
          href: a.href,
          text: a.innerText.trim() || a.getAttribute('aria-label') || a.getAttribute('title') || 'No text',
          location: 'Body',
          index: index,
          id: `link-${index}`
        };
      });
  });

  console.log(`\nFound ${links.length} total links on the page\n`);

  const results = {
    working: [],
    broken: [],
    total: links.length
  };

  // Check each link
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    console.log(`[${i + 1}/${links.length}] Checking: ${link.href}`);
    
    try {
      // Skip mailto, tel, and javascript links
      if (link.href.startsWith('mailto:') || 
          link.href.startsWith('tel:') || 
          link.href.startsWith('javascript:') ||
          link.href === '' ||
          link.href.startsWith('#')) {
        console.log(`  ✓ Skipped (special protocol)`);
        results.working.push({ ...link, status: 'Skipped - Special Protocol' });
        continue;
      }

      // Try to navigate to the link
      const response = await page.goto(link.href, { 
        waitUntil: 'domcontentloaded',
        timeout: 15000 
      });

      const status = response.status();
      
      if (status >= 200 && status < 400) {
        console.log(`  ✓ Working (${status})`);
        results.working.push({ ...link, status });
      } else {
        console.log(`  ✗ Broken (${status})`);
        results.broken.push({ ...link, status });
        
        // Navigate back and highlight the broken link
        await page.goto(url, { waitUntil: 'networkidle' });
        await highlightBrokenLink(page, link.id, link.href, link.text, status);
        
        // Take screenshot with highlighted link
        const screenshotName = `broken-link-${i + 1}-status-${status}.png`;
        await page.screenshot({ 
          path: path.join(screenshotsDir, screenshotName),
          fullPage: true 
        });
        console.log(`  📸 Screenshot saved: ${screenshotName}`);
        
        // Remove highlights before continuing
        await removeHighlights(page);
      }
      
      // Navigate back to original page
      await page.goto(url, { waitUntil: 'networkidle' });
      
    } catch (error) {
      console.log(`  ✗ Error: ${error.message}`);
      results.broken.push({ 
        ...link, 
        status: 'Error',
        error: error.message 
      });
      
      // Navigate back and highlight the broken link
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
        await highlightBrokenLink(page, link.id, link.href, link.text, 'ERROR: ' + error.message);
        
        // Take screenshot with highlighted link
        const screenshotName = `broken-link-${i + 1}-error.png`;
        await page.screenshot({ 
          path: path.join(screenshotsDir, screenshotName),
          fullPage: true 
        });
        console.log(`  📸 Screenshot saved: ${screenshotName}`);
        
        // Remove highlights
        await removeHighlights(page);
      } catch (navError) {
        console.log(`  Warning: Could not capture screenshot`);
      }
      
      // Navigate back for next iteration
      try {
        await page.goto(url, { waitUntil: 'networkidle' });
      } catch (navError) {
        console.log(`  Warning: Could not navigate back to original page`);
      }
    }
  }

  // Generate summary report
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY REPORT');
  console.log('='.repeat(60));
  console.log(`Total Links: ${results.total}`);
  console.log(`Working Links: ${results.working.length}`);
  console.log(`Broken Links: ${results.broken.length}`);
  
  if (results.broken.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('BROKEN LINKS DETAILS:');
    console.log('-'.repeat(60));
    results.broken.forEach((link, index) => {
      console.log(`\n${index + 1}. ${link.text}`);
      console.log(`   URL: ${link.href}`);
      console.log(`   Location: ${link.location}`);
      console.log(`   Status: ${link.status}`);
      if (link.error) {
        console.log(`   Error: ${link.error}`);
      }
    });
  }

  // Save report to JSON file
  const reportPath = './link-check-report.json';
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 Full report saved to: ${reportPath}`);
  console.log(`📁 Screenshots saved to: ${screenshotsDir}/`);

  await browser.close();
  return results;
}

// Function to highlight broken link on the page
async function highlightBrokenLink(page, linkId, linkHref, linkText, status) {
  await page.evaluate(({ id, href, text, statusCode }) => {
    // Try to find the link by the data attribute first
    let link = document.querySelector(`a[data-link-checker-id="${id}"]`);
    
    // If not found (page was reloaded), try to find by href and/or text and re-add the data attribute
    if (!link) {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      // Prefer exact href match (absolute). Fallback to matching by text if necessary.
      link = anchors.find(a => a.href === href) || anchors.find(a => (a.innerText || '').trim() === text);
      if (link) {
        try {
          link.setAttribute('data-link-checker-id', id);
        } catch (e) {
          // ignore
        }
      }
    }
    
    if (!link) {
      // nothing to highlight
      return;
    }
    
    // Apply highlight styles directly to the link
    link.style.cssText += `
      border: 5px solid red !important;
      background-color: rgba(255, 0, 0, 0.2) !important;
      outline: 3px solid orange !important;
      outline-offset: 2px !important;
      position: relative !important;
      z-index: 9999 !important;
      box-shadow: 0 0 20px rgba(255, 0, 0, 0.8) !important;
    `;
    
    // Scroll the link into view (use a standard behavior)
    try {
      link.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch (e) {
      // fallback if scrollIntoView options not supported
      link.scrollIntoView();
    }
    
    // Create a floating banner at the top of the page
    const banner = document.createElement('div');
    banner.id = 'broken-link-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background-color: #dc3545;
      color: white;
      padding: 15px 20px;
      font-size: 16px;
      font-weight: bold;
      z-index: 999999;
      box-shadow: 0 4px 8px rgba(0,0,0,0.3);
      font-family: Arial, sans-serif;
      text-align: center;
    `;
    banner.innerHTML = `
      <div>❌ BROKEN LINK DETECTED - Status: ${statusCode}</div>
      <div style="font-size: 14px; margin-top: 5px; font-weight: normal;">Link Text: "${text || 'N/A'}"</div>
      <div style="font-size: 12px; margin-top: 3px; font-weight: normal; word-break: break-all;">URL: ${href}</div>
    `;
    document.body.appendChild(banner);
    
    // Create an arrow pointing to the link
    const arrow = document.createElement('div');
    arrow.className = 'broken-link-arrow';
    arrow.style.cssText = `
      position: fixed;
      left: 20px;
      font-size: 48px;
      color: red;
      z-index: 999998;
      animation: bounce 1s infinite;
      pointer-events: none;
    `;
    arrow.textContent = '👉';
    
    // Position arrow next to the link
    const rect = link.getBoundingClientRect();
    arrow.style.top = `${rect.top + rect.height / 2 - 24}px`;
    document.body.appendChild(arrow);
    
    // Add animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes bounce {
        0%, 100% { transform: translateX(0); }
        50% { transform: translateX(10px); }
      }
    `;
    document.head.appendChild(style);
    
  }, { id: linkId, href: linkHref, text: linkText, statusCode: status });
  
  // Wait for rendering
  await page.waitForTimeout(1000);
}

// Function to remove highlights
async function removeHighlights(page) {
  await page.evaluate(() => {
    const banner = document.getElementById('broken-link-banner');
    if (banner) banner.remove();
    
    const arrows = document.querySelectorAll('.broken-link-arrow');
    arrows.forEach(arrow => arrow.remove());
  });
}

// Function to close interstitial popups and modals
async function closeInterstitialPopups(page) {
  try {
    // Wait a bit for popups to appear
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      // Close common modal/popup selectors
      const closeSelectors = [
        '[aria-label*="close" i]',
        '[title*="close" i]',
        'button[class*="close" i]',
        'button[class*="dismiss" i]',
        '.modal-close',
        '.popup-close',
        '[role="button"][aria-label*="close" i]',
        'a[aria-label*="close" i]',
        'div[class*="close-btn"]'
      ];

      for (const selector of closeSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          // Only click visible elements
          if (el.offsetParent !== null) {
            try {
              el.click();
              console.log('Closed popup');
              break;
            } catch (e) {
              // ignore
            }
          }
        }
      }

      // Also try pressing Escape key
      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true
      });
      document.dispatchEvent(escapeEvent);
    });

    await page.waitForTimeout(300);
  } catch (e) {
    // silently ignore popup closing errors
  }
}

// Usage
const targetUrl = process.argv[2] || 'https://example.com';
checkAllLinks(targetUrl)
  .then(() => console.log('\n✅ Link check completed!'))
  .catch(err => console.error('❌ Error:', err));