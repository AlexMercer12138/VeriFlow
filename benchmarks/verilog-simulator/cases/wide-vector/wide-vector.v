module wide_vector_bench;
  integer i;
  reg [1023:0] value;
  reg [1023:0] inverse;
  reg [1023:0] result;

  initial begin
    value = {32{32'h01234567}};
    inverse = 0;
    result = 0;
    for (i = 0; i < 5000; i = i + 1) begin
      value = {value[1014:0], value[1023:1015]};
      inverse = ~value;
      result = (value & inverse) | (value ^ inverse);
      if (result !== {1024{1'b1}}) begin
        $display("FAIL wide-vector");
        $finish;
      end
    end
    $display("PASS wide-vector");
    $finish;
  end
endmodule
