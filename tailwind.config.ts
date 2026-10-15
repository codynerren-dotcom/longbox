import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0d0e12",
        panel: "#16181e",
        panel2: "#22262f",
        line: "#343a46",
        comic: "rgb(var(--accent-rgb, 255 204 26) / <alpha-value>)",
        slab: "#e7e7e7",
        mist: "#a8adba",
        paper: "#f4f1ea",
      },
      fontFamily: {
        display: ["var(--font-display)", "Impact", "sans-serif"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        comic: "0 10px 30px rgb(var(--accent-rgb, 255 204 26) / 0.28)",
      },
    },
  },
  plugins: [],
};

export default config;
