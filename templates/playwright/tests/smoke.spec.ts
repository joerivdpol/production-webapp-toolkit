import { expect, test } from '@playwright/test';

test('homepage renders and stable public navigation works', async ({ page }) => {
  const fatalErrors: string[] = [];
  page.on('pageerror', (error) => fatalErrors.push(error.message));

  await page.goto('/');

  // ADAPT: use accessible names that are stable product copy, not CSS structure.
  await expect(page).toHaveTitle(/Example application/i);
  await expect(page.getByRole('heading', { name: /Welcome/i })).toBeVisible();

  await page.getByRole('link', { name: /About/i }).click();
  await expect(page).toHaveURL(/\/about\/?$/);
  await expect(page.getByRole('heading', { name: /About/i })).toBeVisible();

  expect(fatalErrors, `Unexpected page errors:\n${fatalErrors.join('\n')}`).toEqual([]);
});
