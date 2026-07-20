/* 공통 Tailwind 설정 — Material Design 3 다크 토큰 + Pretendard/Plus Jakarta Sans */
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "outline": "#8e90a2", "secondary": "#c6c6c7", "on-tertiary": "#313030",
        "on-background": "#e3e2e7", "secondary-fixed": "#e2e2e2", "on-secondary": "#2f3131",
        "tertiary": "#c8c6c5", "inverse-surface": "#e3e2e7", "on-tertiary-container": "#f3f0ef",
        "tertiary-container": "#6e6d6d", "on-primary-container": "#efefff", "surface-variant": "#343539",
        "inverse-primary": "#124af0", "primary-fixed": "#dde1ff", "on-primary-fixed": "#001356",
        "on-error": "#690005", "error-container": "#93000a", "primary": "#b8c3ff",
        "surface-tint": "#b8c3ff", "surface-dim": "#121317", "on-secondary-fixed": "#1a1c1c",
        "error": "#ffb4ab", "background": "#121317", "secondary-container": "#454747",
        "surface-container-highest": "#343539", "tertiary-fixed": "#e5e2e1",
        "on-secondary-fixed-variant": "#454747", "secondary-fixed-dim": "#c6c6c7",
        "on-error-container": "#ffdad6", "on-secondary-container": "#b4b5b5", "on-primary": "#002388",
        "surface-bright": "#38393d", "outline-variant": "#434656", "surface-container-high": "#292a2e",
        "on-primary-fixed-variant": "#0035be", "on-tertiary-fixed-variant": "#474746",
        "tertiary-fixed-dim": "#c8c6c5", "on-tertiary-fixed": "#1c1b1b", "on-surface-variant": "#c4c5d9",
        "inverse-on-surface": "#2f3034", "primary-container": "#2e5bff", "on-surface": "#e3e2e7",
        "primary-fixed-dim": "#b8c3ff", "surface": "#121317", "surface-container": "#1e1f23",
        "surface-container-lowest": "#0d0e12", "surface-container-low": "#1a1b1f",
        "success": "#5bd49a", "success-container": "#0f2e1c"
      },
      borderRadius: { "DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "2xl": "1rem", "3xl": "1.5rem", "full": "9999px" },
      spacing: { "stack-lg": "48px", "base": "8px", "stack-sm": "12px", "stack-md": "24px", "gutter": "16px", "container-margin": "20px" },
      fontFamily: {
        "sans": ["Pretendard", "Plus Jakarta Sans", "system-ui", "sans-serif"],
        "headline-lg-mobile": ["Pretendard", "Plus Jakarta Sans"], "body-lg": ["Pretendard", "Plus Jakarta Sans"],
        "label-sm": ["Pretendard", "Plus Jakarta Sans"], "label-md": ["Pretendard", "Plus Jakarta Sans"],
        "body-md": ["Pretendard", "Plus Jakarta Sans"], "headline-md": ["Pretendard", "Plus Jakarta Sans"],
        "display-lg": ["Plus Jakarta Sans", "Pretendard"], "headline-lg": ["Pretendard", "Plus Jakarta Sans"]
      },
      fontSize: {
        "headline-lg-mobile": ["28px", { "lineHeight": "1.3", "fontWeight": "700" }],
        "body-lg": ["18px", { "lineHeight": "1.6", "fontWeight": "500" }],
        "label-sm": ["12px", { "lineHeight": "1.4", "fontWeight": "500" }],
        "label-md": ["14px", { "lineHeight": "1.4", "letterSpacing": "0.01em", "fontWeight": "600" }],
        "body-md": ["16px", { "lineHeight": "1.6", "fontWeight": "400" }],
        "headline-md": ["24px", { "lineHeight": "1.4", "fontWeight": "700" }],
        "display-lg": ["40px", { "lineHeight": "1.2", "letterSpacing": "-0.02em", "fontWeight": "800" }],
        "headline-lg": ["32px", { "lineHeight": "1.3", "letterSpacing": "-0.01em", "fontWeight": "700" }]
      }
    }
  }
}