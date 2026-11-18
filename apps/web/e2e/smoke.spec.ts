import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string, mfa = false) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (mfa) {
    await expect(page.getByText('Enter your security code')).toBeVisible();
    await page.keyboard.type('123456');
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.locator('#main h1')).toBeVisible();
}

test('registrar searches a student and opens the Emergency View on a phone', async ({ page }) => {
  await signIn(page, 'registrar');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Kwame Agyei');
  await page.getByRole('option', { name: /Kwame Agyei Mensah/ }).click();
  await expect(page.getByRole('heading', { name: /Kwame Agyei Mensah/ })).toBeVisible();

  await page.setViewportSize({ width: 360, height: 740 });
  // Phone shell: navy header, bottom tabs, floating Emergency button.
  await expect(page.getByRole('navigation', { name: 'Phone menu' })).toBeVisible();
  await expect(page.locator('.k-fab')).toBeVisible();
  await page.getByRole('link', { name: 'Emergency View' }).click();
  await expect(page.getByRole('alert', { name: 'Medical alerts' })).toContainText('SEVERE PEANUT ALLERGY');
  const firstCall = page.getByRole('link', { name: /^Call Akosua Owusu/ });
  await expect(firstCall).toHaveAttribute('href', /^tel:\+23324000/);
  const box = await firstCall.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44); // tap target
  // Usable at 360px: nothing wider than the screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByText('Allowed to pick up')).toBeVisible();
});

test('bursar records a payment against a chosen fee and sees the receipt', async ({ page }) => {
  await signIn(page, 'bursar', true);
  await page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Record payment' }).click();
  const student = page.getByRole('textbox', { name: 'Student' });
  await student.click();
  await student.fill('Kwame Agyei');
  await page.getByRole('option', { name: /Kwame Agyei Mensah/ }).click();
  await expect(page.getByText('What is this payment for?')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Paid by/ })).toHaveValue(/Owusu/); // fee payer chosen by default
  // Toggle the first fee that still has a balance and pay part of it.
  const line = page.getByRole('switch', { disabled: false }).first();
  await line.check({ force: true });
  const payingNow = page.getByLabel('Paying now (GH₵)');
  await payingNow.fill('120.50');
  await expect(page.getByLabel(/Total received/)).toHaveValue('120.50');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByText(/Receipt no\. RCP-\d{6}/)).toBeVisible();
  await expect(page.getByText(/Saved\. The server confirmed this payment/)).toBeVisible();
  await expect(page.getByText('GH₵ 120.50').first()).toBeVisible();
});
