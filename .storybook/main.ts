import type { StorybookConfig } from '@storybook/nextjs';

const config: StorybookConfig = {
  stories: [
    '../.storybook/stories/**/*.mdx',
    '../app/components/**/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs'],
  framework: '@storybook/nextjs',
  staticDirs: ['../public'],
};
export default config;
