import type { Meta, StoryObj } from '@storybook/nextjs';
import Sparkline from './Sparkline';

const meta = {
  title: 'L/Sparkline',
  component: Sparkline,
  argTypes: {
    severity: {
      control: 'inline-radio',
      options: [undefined, 'ok', 'warn', 'danger'],
    },
  },
  args: { ariaLabel: 'Sample sparkline' },
} satisfies Meta<typeof Sparkline>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Increasing: Story = {
  args: { values: [1, 2, 3, 5, 8, 13, 21], lastValueLabel: '21' },
};

export const Decreasing: Story = {
  args: { values: [55, 34, 21, 13, 8, 5, 3], severity: 'ok' },
};

export const Volatile: Story = {
  args: {
    values: [12, 8, 14, 6, 18, 4, 22, 9, 19],
    severity: 'warn',
    lastValueLabel: 'p99 climbing',
  },
};

export const FlatLine: Story = {
  args: { values: [10, 10, 10, 10, 10, 10] },
};

export const SingleSample: Story = {
  args: { values: [42], lastValueLabel: 'not enough data' },
};

export const Danger: Story = {
  args: { values: [2, 4, 8, 16, 32, 64], severity: 'danger' },
};
