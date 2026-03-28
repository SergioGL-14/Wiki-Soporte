using System;

namespace WikiProto.Models
{
    public class Revision
    {
        public long Id { get; set; }
        public long PageId { get; set; }
        public string HtmlContent { get; set; } = string.Empty;
        public string Author { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }
}