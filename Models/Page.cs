using System;

namespace WikiProto.Models
{
    public class Page
    {
        public long Id { get; set; }
        public string Slug { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string HtmlContent { get; set; } = string.Empty;
        public string Excerpt { get; set; } = string.Empty;
        // categories stored as comma-separated values in DB
        public string Categories { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
    }
}