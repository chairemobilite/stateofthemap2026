\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{osmscience}[2026/06/10 OSMScience proceedings class]

\DeclareOption*{\PassOptionsToClass{\CurrentOption}{article}}
\ProcessOptions\relax
\LoadClass[a4paper,11pt]{article}

% --- packages ---
\RequirePackage[margin=1in, bottom=1.5in]{geometry}
\RequirePackage{graphicx}
\RequirePackage{fancyhdr}
\RequirePackage{authblk}
\RequirePackage{csquotes}
\RequirePackage[backend=biber,style=numeric,sorting=none]{biblatex}
\RequirePackage{hyperref}



\newcommand{\procDoi}{}% storage for DOI (default empty)
\newcommand{\proceedingsDOI}[1]{\gdef\procDoi{#1}}% user command to set DOI

\newcommand{\procFirstpage}{1}% storage for first-page number (default 1)
\newcommand{\proceedingsFirstPage}[1]{\gdef\procFirstpage{#1}\setcounter{page}{#1}}% set and apply


\RequirePackage{iftex}
\ifPDFTeX
% pdfLaTeX fallback: try roboto package (may not be available)
\RequirePackage[sfdefault]{roboto}
\renewcommand\familydefault{\sfdefault}
\else
\RequirePackage{fontspec}
\setmainfont{Roboto}
\fi

% Allow user to add bibliography resources in document
% (do not call \addbibresource here to let authors supply it)

\makeatletter
% define 22pt font size command
\newcommand\titleTwentyTwo{\fontsize{22}{26}\selectfont}

% --- title/author formatting: left aligned whole block ---
\makeatletter
\renewcommand\AB@maketitle{%
  \begingroup
    \raggedright
    {\titleTwentyTwo \@title\par}\vskip 1em
    \AB@authlist\par\vskip 1em
    \AB@affillist\par\vskip 1em
    \textasteriskcentered\ Author to whom correspondence should be addressed.\\
    This abstract was accepted to the OSMScience 2026 Conference after peer-review.\par\vskip 0.5em
    \hrule
    \par\vskip 1em
  \endgroup
}
% expose \printauthlist for footers
\newcommand{\printauthlist}{\AB@authlist}
\makeatother

% --- fancyhdr setup ---
\DeclareOption{proctitle}{\def\proc@title{Proceedings of the OSMScience 2026}}
\ProcessOptions\relax
\providecommand{\procTitle}{Proceedings of the OSMScience 2026}
\RequirePackage{etoolbox}

\makeatletter
% save \title content into \proc@titletext whenever \title{...} is used
\let\old@title\title
\renewcommand{\title}[1]{\old@title{#1}\gdef\procTitletext{#1}}
% ensure proc@titletext has a default
\providecommand\procTitletext{}
\makeatother

\fancypagestyle{fancy}{%
    \fancyhf{}%
    \renewcommand{\headrulewidth}{0.5pt}%
    \renewcommand{\footrulewidth}{0.5pt}%
    \fancyhead[L]{\small\procTitle}%
    \fancyhead[R]{\small August 28-30, 2026 | Champs-sur-Marne, France}%
    \fancyfoot[C]{\footnotesize Page \thepage}%
}
% apply to all pages
\pagestyle{fancy}

% style for the first page (left footer block)
\fancypagestyle{plain}{%
    \fancyhf{}%
    \renewcommand{\headrulewidth}{0.5pt}%
    \renewcommand{\footrulewidth}{0.5pt}%
    \fancyhead[L]{\small\procTitle}%
    \fancyhead[R]{\small August 28-30, 2026 | Champs-sur-Marne, France}%
    \fancyfoot[L]{%
        \footnotesize
        \printauthlist\ (2026). \procTitletext\par
        In: \procTitle\par
        DOI: \ifx\procDoi\@empty \textbf{[doi will appear here as a hyperlink]}\else\href{https://doi.org/\procDoi}{\procDoi}\fi\par
        © 2026 by the authors. Available under the terms of the Creative Commons Attribution (\href{http://creativecommons.org/licenses/by/4.0}{CC BY 4.0}) license.%
    }%
}

% helper short commands from your template
\newcommand\figref{Figure~\ref}

% sensible defaults authors can override
\setcounter{secnumdepth}{0}% no section numbering for abstracts

\setlength{\parindent}{0.5in}
\makeatletter
\renewcommand{\headrule}{\vskip10pt\hrule\@height\headrulewidth}
\makeatother
\setlength{\headsep}{30pt}
\setlength{\headheight}{22.5pt}
\AtBeginDocument{\thispagestyle{plain}}
% End of class
