// Inputs for the "Try a sample" control. Each text is correct English as it
// stands; a few plain phrases ("very interesting", "a lot of") are kept so a
// learner has something to polish. Expected corrections are deliberately not
// stored here: the checker decides what to suggest.

export type SampleText = {
  id: string;
  title: string;
  text: string;
};

// A tuple, so the list cannot silently grow or shrink.
export const SAMPLE_TEXTS: readonly [SampleText, SampleText, SampleText] = [
  {
    id: "new-job",
    title: "A new job",
    text: "I started a new job last month. The people are friendly, and the work is very interesting. I am glad I made the change.",
  },
  {
    id: "coast-day",
    title: "A day at the coast",
    text: "Last weekend, my friend and I took the train to the coast. We walked along the beach for a few hours and ate a lot of fresh fish. It was a relaxing day, and we hope to go back soon.",
  },
  {
    id: "morning-walk",
    title: "A morning walk",
    text: "Every morning, I walk my dog before breakfast. It helps me wake up and think about the day ahead. Sometimes I listen to a podcast while we walk, and I learn something new.",
  },
];
