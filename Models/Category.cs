using System;
using System.ComponentModel.DataAnnotations.Schema;

namespace WikiProto.Models
{
    public class Category
    {
        public long Id { get; set; }
        public string Name { get; set; } = string.Empty;
        
        [Column("parent_id")]
        public long? ParentId { get; set; }
        
        [Column("created_at")]
        public DateTime CreatedAt { get; set; }
        
        [Column("updated_at")]
        public DateTime UpdatedAt { get; set; }
    }
}